#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { Request, Response } from 'express';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as common from 'oci-common';
import * as core from 'oci-core';
import * as identity from 'oci-identity';
import * as objectstorage from 'oci-objectstorage';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Configuração via variáveis de ambiente
// ---------------------------------------------------------------------------
type AuthMode = 'config' | 'apikey' | 'instance_principal' | 'session';

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  }
  return value;
}

function getAuthMode(): AuthMode {
  const rawMode = (process.env.OCI_AUTH_MODE ?? 'config').toLowerCase();
  if (
    rawMode === 'config' ||
    rawMode === 'apikey' ||
    rawMode === 'instance_principal' ||
    rawMode === 'session'
  ) {
    return rawMode;
  }
  throw new Error(
    `Valor inválido para OCI_AUTH_MODE: ${rawMode}. Valores aceitos: config, apikey, instance_principal, session`
  );
}

const authMode = getAuthMode();
const OCI_READ_ONLY = parseBoolean(process.env.OCI_READ_ONLY, true);

type ProviderWithTenantId = common.AuthenticationDetailsProvider & { getTenantId(): string };

function hasTenantId(provider: common.AuthenticationDetailsProvider): provider is ProviderWithTenantId {
  return typeof (provider as Partial<ProviderWithTenantId>).getTenantId === 'function';
}

/**
 * Sem compartmentId explícito, cai no compartment raiz da tenancy (getTenantId()).
 * Só disponível para os providers que carregam a tenancy diretamente (config/apikey/session);
 * no modo instance_principal a tenancy não fica exposta no provider, então exige o argumento.
 */
function resolveCompartmentId(
  provider: common.AuthenticationDetailsProvider,
  argCompartmentId?: string
): string {
  if (argCompartmentId) {
    return argCompartmentId;
  }
  if (hasTenantId(provider)) {
    return provider.getTenantId();
  }
  throw new Error(
    'compartmentId não informado. No modo instance_principal não é possível resolver o compartment raiz automaticamente — informe compartmentId explicitamente (use list_compartments para descobrir o OCID).'
  );
}

async function buildProvider(): Promise<common.AuthenticationDetailsProvider> {
  const configFilePath = process.env.OCI_CONFIG_FILE;
  const configProfile = process.env.OCI_CONFIG_PROFILE;

  switch (authMode) {
    case 'config':
      return new common.ConfigFileAuthenticationDetailsProvider(configFilePath, configProfile);

    case 'session':
      return new common.SessionAuthDetailProvider(configFilePath, configProfile);

    case 'instance_principal':
      return await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();

    case 'apikey': {
      const tenancy = requireEnv('OCI_TENANCY_ID');
      const user = requireEnv('OCI_USER_ID');
      const fingerprint = requireEnv('OCI_FINGERPRINT');
      const region = requireEnv('OCI_REGION');
      const passphrase = process.env.OCI_PRIVATE_KEY_PASSPHRASE ?? null;

      let privateKey: string;
      if (process.env.OCI_PRIVATE_KEY) {
        privateKey = process.env.OCI_PRIVATE_KEY.replace(/\\n/g, '\n');
      } else {
        const privateKeyPath = requireEnv('OCI_PRIVATE_KEY_PATH');
        privateKey = readFileSync(privateKeyPath, 'utf-8');
      }

      return new common.SimpleAuthenticationDetailsProvider(
        tenancy,
        user,
        fingerprint,
        privateKey,
        passphrase,
        common.Region.fromRegionId(region)
      );
    }
  }
}

let providerPromise: Promise<common.AuthenticationDetailsProvider> | null = null;

function getProvider(): Promise<common.AuthenticationDetailsProvider> {
  if (!providerPromise) {
    providerPromise = buildProvider();
  }
  return providerPromise;
}

type OciClients = {
  provider: common.AuthenticationDetailsProvider;
  compute: core.ComputeClient;
  vcn: core.VirtualNetworkClient;
  objectStorage: objectstorage.ObjectStorageClient;
  identity: identity.IdentityClient;
};

const clientsByRegion = new Map<string, OciClients>();

/**
 * Constrói (e cacheia) um conjunto de clients por região. OCI é um serviço regional para
 * Compute/Networking/Object Storage — sem isso, uma chamada com regionId diferente do
 * default do provider retornaria vazio/404 mesmo com o compartmentId e OCID corretos.
 */
async function getClients(regionId?: string): Promise<OciClients> {
  const cacheKey = regionId ?? process.env.OCI_REGION ?? '__provider_default__';
  const cached = clientsByRegion.get(cacheKey);
  if (cached) {
    return cached;
  }

  const provider = await getProvider();
  const compute = new core.ComputeClient({ authenticationDetailsProvider: provider });
  const vcn = new core.VirtualNetworkClient({ authenticationDetailsProvider: provider });
  const objectStorage = new objectstorage.ObjectStorageClient({
    authenticationDetailsProvider: provider,
  });
  const identityClient = new identity.IdentityClient({ authenticationDetailsProvider: provider });

  const effectiveRegionId = regionId ?? process.env.OCI_REGION;
  if (effectiveRegionId) {
    const region = common.Region.fromRegionId(effectiveRegionId);
    compute.region = region;
    vcn.region = region;
    objectStorage.region = region;
    identityClient.region = region;
  }

  const result: OciClients = { provider, compute, vcn, objectStorage, identity: identityClient };
  clientsByRegion.set(cacheKey, result);
  return result;
}

let namespaceCache: string | null = null;

async function resolveNamespace(objectStorage: objectstorage.ObjectStorageClient, argNamespace?: string): Promise<string> {
  if (argNamespace) {
    return argNamespace;
  }
  if (namespaceCache) {
    return namespaceCache;
  }
  const response = await objectStorage.getNamespace({});
  namespaceCache = response.value;
  return namespaceCache;
}

const VALID_INSTANCE_ACTIONS = new Set([
  'START',
  'STOP',
  'SOFTSTOP',
  'RESET',
  'SOFTRESET',
  'SENDDIAGNOSTICINTERRUPT',
]);

function toInstanceAction(action: string): string {
  const normalized = action.toUpperCase();
  if (!VALID_INSTANCE_ACTIONS.has(normalized)) {
    throw new Error(
      `Ação inválida: ${action}. Valores aceitos: ${[...VALID_INSTANCE_ACTIONS].join(', ')}`
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Projeção de campos — por padrão as tools devolvem um resumo enxuto de cada
// recurso (o payload bruto da OCI para uma instância, por exemplo, inclui
// chave SSH, plugins de agente, launch options etc. e passa fácil de 1500
// linhas). Passe raw=true na chamada para receber o objeto completo do SDK.
// ---------------------------------------------------------------------------
function summarizeInstance(i: core.models.Instance) {
  return {
    id: i.id,
    displayName: i.displayName,
    lifecycleState: i.lifecycleState,
    shape: i.shape,
    ocpus: i.shapeConfig?.ocpus,
    memoryInGBs: i.shapeConfig?.memoryInGBs,
    availabilityDomain: i.availabilityDomain,
    faultDomain: i.faultDomain,
    compartmentId: i.compartmentId,
    region: i.region,
    timeCreated: i.timeCreated,
    freeformTags: i.freeformTags,
    definedTags: i.definedTags,
  };
}

function summarizeVnicAttachment(v: core.models.VnicAttachment) {
  return {
    id: v.id,
    displayName: v.displayName,
    instanceId: v.instanceId,
    vnicId: v.vnicId,
    subnetId: v.subnetId,
    availabilityDomain: v.availabilityDomain,
    lifecycleState: v.lifecycleState,
    timeCreated: v.timeCreated,
  };
}

function summarizeVcn(v: core.models.Vcn) {
  return {
    id: v.id,
    displayName: v.displayName,
    cidrBlock: v.cidrBlock,
    cidrBlocks: v.cidrBlocks,
    dnsLabel: v.dnsLabel,
    lifecycleState: v.lifecycleState,
    compartmentId: v.compartmentId,
    timeCreated: v.timeCreated,
  };
}

function summarizeSubnet(s: core.models.Subnet) {
  return {
    id: s.id,
    displayName: s.displayName,
    cidrBlock: s.cidrBlock,
    vcnId: s.vcnId,
    availabilityDomain: s.availabilityDomain,
    lifecycleState: s.lifecycleState,
    compartmentId: s.compartmentId,
    prohibitPublicIpOnVnic: s.prohibitPublicIpOnVnic,
    timeCreated: s.timeCreated,
  };
}

function summarizeSecurityList(sl: core.models.SecurityList) {
  return {
    id: sl.id,
    displayName: sl.displayName,
    vcnId: sl.vcnId,
    lifecycleState: sl.lifecycleState,
    compartmentId: sl.compartmentId,
    ingressRuleCount: sl.ingressSecurityRules?.length ?? 0,
    egressRuleCount: sl.egressSecurityRules?.length ?? 0,
    timeCreated: sl.timeCreated,
  };
}

function summarizeNsg(n: core.models.NetworkSecurityGroup) {
  return {
    id: n.id,
    displayName: n.displayName,
    vcnId: n.vcnId,
    lifecycleState: n.lifecycleState,
    compartmentId: n.compartmentId,
    timeCreated: n.timeCreated,
  };
}

function summarizeRouteTable(rt: core.models.RouteTable) {
  return {
    id: rt.id,
    displayName: rt.displayName,
    vcnId: rt.vcnId,
    lifecycleState: rt.lifecycleState,
    compartmentId: rt.compartmentId,
    routeRuleCount: rt.routeRules?.length ?? 0,
    timeCreated: rt.timeCreated,
  };
}

function summarizeBucket(b: objectstorage.models.Bucket | objectstorage.models.BucketSummary) {
  const full = b as Partial<objectstorage.models.Bucket>;
  return {
    name: b.name,
    namespace: b.namespace,
    compartmentId: b.compartmentId,
    timeCreated: b.timeCreated,
    storageTier: full.storageTier,
    publicAccessType: full.publicAccessType,
    versioning: full.versioning,
    approximateCount: full.approximateCount,
    approximateSize: full.approximateSize,
  };
}

// ---------------------------------------------------------------------------
// Metadados das ferramentas (controle do modo somente leitura)
// ---------------------------------------------------------------------------
const TOOL_MUTATING: Record<string, boolean> = {
  list_regions: false,
  list_compartments: false,
  list_instances: false,
  get_instance: false,
  list_vnic_attachments: false,
  instance_action: true,
  list_vcns: false,
  get_vcn: false,
  list_subnets: false,
  list_security_lists: false,
  list_network_security_groups: false,
  list_route_tables: false,
  get_namespace: false,
  list_buckets: false,
  get_bucket: false,
  list_objects: false,
  create_bucket: true,
  delete_object: true,
};

// ---------------------------------------------------------------------------
// Servidor MCP
// ---------------------------------------------------------------------------
function createServer(): Server {
  const server = new Server(
    { name: 'mcp-oci', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // -------------------------------------------------------------------------
  // Definição das ferramentas
  // -------------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_regions',
        description:
          'Lists the OCI regions this tenancy is subscribed to (region ID, region key, home region flag). Use this to resolve a region name (e.g. "Vinhedo", "São Paulo") to its region ID (e.g. "sa-vinhedo-1") before passing it as the region argument to other tools.',
        inputSchema: {
          type: 'object',
          properties: {
            tenancyId: {
              type: 'string',
              description: 'Tenancy OCID (default: resolved from the auth provider, same rule as compartmentId)',
            },
          },
        },
      },
      {
        name: 'list_compartments',
        description:
          'Lists compartments by name and/or parent compartment. Use this to resolve a compartment name (e.g. "cpLinux") to its OCID before calling other tools. Defaults to searching the entire tenancy tree from the root compartment.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Exact compartment name to filter by (e.g. "cpLinux", "cpFiles")',
            },
            compartmentId: {
              type: 'string',
              description: 'Parent compartment OCID to search under (default: tenancy root)',
            },
            includeSubtree: {
              type: 'boolean',
              description: 'Search the whole hierarchy below the parent compartment (default: true)',
            },
          },
        },
      },
      {
        name: 'list_instances',
        description: 'Lists Compute instances in a compartment. Returns a trimmed summary per instance unless raw=true.',
        inputSchema: {
          type: 'object',
          properties: {
            compartmentId: {
              type: 'string',
              description: 'Compartment OCID (default: tenancy root)',
            },
            availabilityDomain: {
              type: 'string',
              description: 'Optional availability domain filter',
            },
            region: {
              type: 'string',
              description: 'OCI region ID to query (e.g. sa-vinhedo-1, sa-saopaulo-1). Default: server-configured region',
            },
            raw: {
              type: 'boolean',
              description: 'Return the full OCI SDK object per instance instead of the trimmed summary (default: false)',
            },
          },
        },
      },
      {
        name: 'get_instance',
        description: 'Returns details of a specific Compute instance. Returns a trimmed summary unless raw=true.',
        inputSchema: {
          type: 'object',
          properties: {
            instanceId: { type: 'string', description: 'Instance OCID' },
            region: {
              type: 'string',
              description: 'OCI region ID where the instance lives (e.g. sa-vinhedo-1). Default: server-configured region',
            },
            raw: {
              type: 'boolean',
              description: 'Return the full OCI SDK object instead of the trimmed summary (default: false)',
            },
          },
          required: ['instanceId'],
        },
      },
      {
        name: 'list_vnic_attachments',
        description: 'Lists VNIC attachments in a compartment, optionally filtered by instance. Returns a trimmed summary unless raw=true.',
        inputSchema: {
          type: 'object',
          properties: {
            compartmentId: {
              type: 'string',
              description: 'Compartment OCID (default: tenancy root)',
            },
            instanceId: { type: 'string', description: 'Optional instance OCID filter' },
            region: {
              type: 'string',
              description: 'OCI region ID to query (e.g. sa-vinhedo-1). Default: server-configured region',
            },
            raw: {
              type: 'boolean',
              description: 'Return the full OCI SDK object per attachment instead of the trimmed summary (default: false)',
            },
          },
        },
      },
      {
        name: 'instance_action',
        description:
          'Performs a lifecycle action on a Compute instance (START, STOP, SOFTSTOP, RESET, SOFTRESET, SENDDIAGNOSTICINTERRUPT). Blocked when OCI_READ_ONLY=true.',
        inputSchema: {
          type: 'object',
          properties: {
            instanceId: { type: 'string', description: 'Instance OCID' },
            action: {
              type: 'string',
              description: 'START | STOP | SOFTSTOP | RESET | SOFTRESET | SENDDIAGNOSTICINTERRUPT',
            },
            region: {
              type: 'string',
              description: 'OCI region ID where the instance lives (e.g. sa-vinhedo-1). Default: server-configured region',
            },
          },
          required: ['instanceId', 'action'],
        },
      },
      {
        name: 'list_vcns',
        description: 'Lists Virtual Cloud Networks (VCNs) in a compartment. Returns a trimmed summary per VCN unless raw=true.',
        inputSchema: {
          type: 'object',
          properties: {
            compartmentId: {
              type: 'string',
              description: 'Compartment OCID (default: tenancy root)',
            },
            region: {
              type: 'string',
              description: 'OCI region ID to query (e.g. sa-vinhedo-1). Default: server-configured region',
            },
            raw: {
              type: 'boolean',
              description: 'Return the full OCI SDK object per VCN instead of the trimmed summary (default: false)',
            },
          },
        },
      },
      {
        name: 'get_vcn',
        description: 'Returns details of a specific VCN. Returns a trimmed summary unless raw=true.',
        inputSchema: {
          type: 'object',
          properties: {
            vcnId: { type: 'string', description: 'VCN OCID' },
            region: {
              type: 'string',
              description: 'OCI region ID where the VCN lives (e.g. sa-vinhedo-1). Default: server-configured region',
            },
            raw: {
              type: 'boolean',
              description: 'Return the full OCI SDK object instead of the trimmed summary (default: false)',
            },
          },
          required: ['vcnId'],
        },
      },
      {
        name: 'list_subnets',
        description: 'Lists subnets in a compartment, optionally filtered by VCN. Returns a trimmed summary per subnet unless raw=true.',
        inputSchema: {
          type: 'object',
          properties: {
            compartmentId: {
              type: 'string',
              description: 'Compartment OCID (default: tenancy root)',
            },
            vcnId: { type: 'string', description: 'Optional VCN OCID filter' },
            region: {
              type: 'string',
              description: 'OCI region ID to query (e.g. sa-vinhedo-1). Default: server-configured region',
            },
            raw: {
              type: 'boolean',
              description: 'Return the full OCI SDK object per subnet instead of the trimmed summary (default: false)',
            },
          },
        },
      },
      {
        name: 'list_security_lists',
        description:
          'Lists security lists in a compartment, optionally filtered by VCN. Returns a trimmed summary (with ingress/egress rule counts) per list unless raw=true — pass raw=true to inspect the actual rules.',
        inputSchema: {
          type: 'object',
          properties: {
            compartmentId: {
              type: 'string',
              description: 'Compartment OCID (default: tenancy root)',
            },
            vcnId: { type: 'string', description: 'Optional VCN OCID filter' },
            region: {
              type: 'string',
              description: 'OCI region ID to query (e.g. sa-vinhedo-1). Default: server-configured region',
            },
            raw: {
              type: 'boolean',
              description: 'Return the full OCI SDK object (including ingress/egress rules) per list instead of the trimmed summary (default: false)',
            },
          },
        },
      },
      {
        name: 'list_network_security_groups',
        description: 'Lists network security groups (NSGs) in a compartment, optionally filtered by VCN. Returns a trimmed summary per NSG unless raw=true.',
        inputSchema: {
          type: 'object',
          properties: {
            compartmentId: {
              type: 'string',
              description: 'Compartment OCID (default: tenancy root)',
            },
            vcnId: { type: 'string', description: 'Optional VCN OCID filter' },
            region: {
              type: 'string',
              description: 'OCI region ID to query (e.g. sa-vinhedo-1). Default: server-configured region',
            },
            raw: {
              type: 'boolean',
              description: 'Return the full OCI SDK object per NSG instead of the trimmed summary (default: false)',
            },
          },
        },
      },
      {
        name: 'list_route_tables',
        description:
          'Lists route tables in a compartment, optionally filtered by VCN. Returns a trimmed summary (with route rule count) per table unless raw=true — pass raw=true to inspect the actual routes.',
        inputSchema: {
          type: 'object',
          properties: {
            compartmentId: {
              type: 'string',
              description: 'Compartment OCID (default: tenancy root)',
            },
            vcnId: { type: 'string', description: 'Optional VCN OCID filter' },
            region: {
              type: 'string',
              description: 'OCI region ID to query (e.g. sa-vinhedo-1). Default: server-configured region',
            },
            raw: {
              type: 'boolean',
              description: 'Return the full OCI SDK object (including route rules) per table instead of the trimmed summary (default: false)',
            },
          },
        },
      },
      {
        name: 'get_namespace',
        description: 'Returns the Object Storage namespace for the tenancy.',
        inputSchema: {
          type: 'object',
          properties: {
            region: {
              type: 'string',
              description: 'OCI region ID to query (e.g. sa-vinhedo-1). Default: server-configured region',
            },
          },
        },
      },
      {
        name: 'list_buckets',
        description: 'Lists Object Storage buckets in a compartment. Returns a trimmed summary per bucket unless raw=true.',
        inputSchema: {
          type: 'object',
          properties: {
            compartmentId: {
              type: 'string',
              description: 'Compartment OCID (default: tenancy root)',
            },
            namespace: {
              type: 'string',
              description: 'Object Storage namespace (default: auto-resolved)',
            },
            region: {
              type: 'string',
              description: 'OCI region ID to query (e.g. sa-vinhedo-1). Buckets are regional. Default: server-configured region',
            },
            raw: {
              type: 'boolean',
              description: 'Return the full OCI SDK object per bucket instead of the trimmed summary (default: false)',
            },
          },
        },
      },
      {
        name: 'get_bucket',
        description: 'Returns details of a specific Object Storage bucket. Returns a trimmed summary unless raw=true.',
        inputSchema: {
          type: 'object',
          properties: {
            bucketName: { type: 'string', description: 'Bucket name' },
            namespace: {
              type: 'string',
              description: 'Object Storage namespace (default: auto-resolved)',
            },
            region: {
              type: 'string',
              description: 'OCI region ID where the bucket lives (e.g. sa-vinhedo-1). Default: server-configured region',
            },
            raw: {
              type: 'boolean',
              description: 'Return the full OCI SDK object instead of the trimmed summary (default: false)',
            },
          },
          required: ['bucketName'],
        },
      },
      {
        name: 'list_objects',
        description: 'Lists objects in a bucket, optionally filtered by prefix.',
        inputSchema: {
          type: 'object',
          properties: {
            bucketName: { type: 'string', description: 'Bucket name' },
            namespace: {
              type: 'string',
              description: 'Object Storage namespace (default: auto-resolved)',
            },
            prefix: { type: 'string', description: 'Optional object name prefix filter' },
            limit: { type: 'number', description: 'Max objects to return (default: 100)' },
            region: {
              type: 'string',
              description: 'OCI region ID where the bucket lives (e.g. sa-vinhedo-1). Default: server-configured region',
            },
          },
          required: ['bucketName'],
        },
      },
      {
        name: 'create_bucket',
        description: 'Creates an Object Storage bucket. Blocked when OCI_READ_ONLY=true.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Bucket name' },
            compartmentId: {
              type: 'string',
              description: 'Compartment OCID (default: tenancy root)',
            },
            namespace: {
              type: 'string',
              description: 'Object Storage namespace (default: auto-resolved)',
            },
            publicAccessType: {
              type: 'string',
              description: 'NoPublicAccess | ObjectRead | ObjectReadWithoutList (default: NoPublicAccess)',
            },
            region: {
              type: 'string',
              description: 'OCI region ID to create the bucket in (e.g. sa-vinhedo-1). Default: server-configured region',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'delete_object',
        description: 'Deletes an object from a bucket. Blocked when OCI_READ_ONLY=true.',
        inputSchema: {
          type: 'object',
          properties: {
            bucketName: { type: 'string', description: 'Bucket name' },
            objectName: { type: 'string', description: 'Object name' },
            namespace: {
              type: 'string',
              description: 'Object Storage namespace (default: auto-resolved)',
            },
            region: {
              type: 'string',
              description: 'OCI region ID where the bucket lives (e.g. sa-vinhedo-1). Default: server-configured region',
            },
          },
          required: ['bucketName', 'objectName'],
        },
      },
    ],
  }));

  // -------------------------------------------------------------------------
  // Implementação das ferramentas
  // -------------------------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (OCI_READ_ONLY && TOOL_MUTATING[name]) {
      return {
        content: [
          {
            type: 'text',
            text: `Ferramenta '${name}' bloqueada: servidor em modo somente leitura (OCI_READ_ONLY=true).`,
          },
        ],
        isError: true,
      };
    }

    try {
      const regionId = args?.region as string | undefined;
      const { provider, compute, vcn, objectStorage, identity: identityClient } = await getClients(regionId);

      const raw = (args?.raw as boolean | undefined) ?? false;

      switch (name) {
        case 'list_regions': {
          const tenancyId = resolveCompartmentId(provider, args?.tenancyId as string | undefined);
          const response = await identityClient.listRegionSubscriptions({ tenancyId });
          return { content: [{ type: 'text', text: JSON.stringify(response.items, null, 2) }] };
        }

        case 'list_compartments': {
          const parentCompartmentId = resolveCompartmentId(provider, args?.compartmentId as string | undefined);
          const compartmentName = args?.name as string | undefined;
          const compartmentIdInSubtree = (args?.includeSubtree as boolean | undefined) ?? true;
          const response = await identityClient.listCompartments({
            compartmentId: parentCompartmentId,
            name: compartmentName,
            compartmentIdInSubtree,
            accessLevel: identity.requests.ListCompartmentsRequest.AccessLevel.Accessible,
          });
          return { content: [{ type: 'text', text: JSON.stringify(response.items, null, 2) }] };
        }

        case 'list_instances': {
          const compartmentId = resolveCompartmentId(provider, args?.compartmentId as string | undefined);
          const availabilityDomain = args?.availabilityDomain as string | undefined;
          const response = await compute.listInstances({ compartmentId, availabilityDomain });
          const items = raw ? response.items : response.items.map(summarizeInstance);
          return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        }

        case 'get_instance': {
          const instanceId = args?.instanceId as string;
          const response = await compute.getInstance({ instanceId });
          const item = raw ? response.instance : summarizeInstance(response.instance);
          return { content: [{ type: 'text', text: JSON.stringify(item, null, 2) }] };
        }

        case 'list_vnic_attachments': {
          const compartmentId = resolveCompartmentId(provider, args?.compartmentId as string | undefined);
          const instanceId = args?.instanceId as string | undefined;
          const response = await compute.listVnicAttachments({ compartmentId, instanceId });
          const items = raw ? response.items : response.items.map(summarizeVnicAttachment);
          return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        }

        case 'instance_action': {
          const instanceId = args?.instanceId as string;
          const action = toInstanceAction(args?.action as string);
          const response = await compute.instanceAction({ instanceId, action });
          return { content: [{ type: 'text', text: JSON.stringify(response.instance, null, 2) }] };
        }

        case 'list_vcns': {
          const compartmentId = resolveCompartmentId(provider, args?.compartmentId as string | undefined);
          const response = await vcn.listVcns({ compartmentId });
          const items = raw ? response.items : response.items.map(summarizeVcn);
          return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        }

        case 'get_vcn': {
          const vcnId = args?.vcnId as string;
          const response = await vcn.getVcn({ vcnId });
          const item = raw ? response.vcn : summarizeVcn(response.vcn);
          return { content: [{ type: 'text', text: JSON.stringify(item, null, 2) }] };
        }

        case 'list_subnets': {
          const compartmentId = resolveCompartmentId(provider, args?.compartmentId as string | undefined);
          const vcnId = args?.vcnId as string | undefined;
          const response = await vcn.listSubnets({ compartmentId, vcnId });
          const items = raw ? response.items : response.items.map(summarizeSubnet);
          return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        }

        case 'list_security_lists': {
          const compartmentId = resolveCompartmentId(provider, args?.compartmentId as string | undefined);
          const vcnId = args?.vcnId as string | undefined;
          const response = await vcn.listSecurityLists({ compartmentId, vcnId });
          const items = raw ? response.items : response.items.map(summarizeSecurityList);
          return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        }

        case 'list_network_security_groups': {
          const compartmentId = resolveCompartmentId(provider, args?.compartmentId as string | undefined);
          const vcnId = args?.vcnId as string | undefined;
          const response = await vcn.listNetworkSecurityGroups({ compartmentId, vcnId });
          const items = raw ? response.items : response.items.map(summarizeNsg);
          return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        }

        case 'list_route_tables': {
          const compartmentId = resolveCompartmentId(provider, args?.compartmentId as string | undefined);
          const vcnId = args?.vcnId as string | undefined;
          const response = await vcn.listRouteTables({ compartmentId, vcnId });
          const items = raw ? response.items : response.items.map(summarizeRouteTable);
          return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        }

        case 'get_namespace': {
          const namespace = await resolveNamespace(objectStorage);
          return { content: [{ type: 'text', text: namespace }] };
        }

        case 'list_buckets': {
          const compartmentId = resolveCompartmentId(provider, args?.compartmentId as string | undefined);
          const namespaceName = await resolveNamespace(objectStorage, args?.namespace as string | undefined);
          const response = await objectStorage.listBuckets({ namespaceName, compartmentId });
          const items = raw ? response.items : response.items.map(summarizeBucket);
          return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        }

        case 'get_bucket': {
          const bucketName = args?.bucketName as string;
          const namespaceName = await resolveNamespace(objectStorage, args?.namespace as string | undefined);
          const response = await objectStorage.getBucket({ namespaceName, bucketName });
          const item = raw ? response.bucket : summarizeBucket(response.bucket);
          return { content: [{ type: 'text', text: JSON.stringify(item, null, 2) }] };
        }

        case 'list_objects': {
          const bucketName = args?.bucketName as string;
          const namespaceName = await resolveNamespace(objectStorage, args?.namespace as string | undefined);
          const prefix = args?.prefix as string | undefined;
          const limit = (args?.limit as number | undefined) ?? 100;
          const response = await objectStorage.listObjects({
            namespaceName,
            bucketName,
            prefix,
            limit,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(response.listObjects.objects, null, 2) }],
          };
        }

        case 'create_bucket': {
          const bucketName = args?.name as string;
          const compartmentId = resolveCompartmentId(provider, args?.compartmentId as string | undefined);
          const namespaceName = await resolveNamespace(objectStorage, args?.namespace as string | undefined);
          const publicAccessType =
            (args?.publicAccessType as objectstorage.models.CreateBucketDetails.PublicAccessType | undefined) ??
            objectstorage.models.CreateBucketDetails.PublicAccessType.NoPublicAccess;
          const response = await objectStorage.createBucket({
            namespaceName,
            createBucketDetails: { name: bucketName, compartmentId, publicAccessType },
          });
          return { content: [{ type: 'text', text: JSON.stringify(response.bucket, null, 2) }] };
        }

        case 'delete_object': {
          const bucketName = args?.bucketName as string;
          const objectName = args?.objectName as string;
          const namespaceName = await resolveNamespace(objectStorage, args?.namespace as string | undefined);
          await objectStorage.deleteObject({ namespaceName, bucketName, objectName });
          return {
            content: [{ type: 'text', text: `Object '${objectName}' deleted from bucket '${bucketName}'.` }],
          };
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();

async function startHttpServer() {
  const port = Number.parseInt(process.env.MCP_HTTP_PORT ?? '3003', 10);
  const host = process.env.MCP_HTTP_HOST ?? '0.0.0.0';
  const app = createMcpExpressApp({ host });

  app.post('/mcp', async (req: Request, res: Response) => {
    const server = createServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  const methodNotAllowedBody = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
  app.get('/mcp', (_req: Request, res: Response) => {
    res.writeHead(405).end(methodNotAllowedBody);
  });
  app.delete('/mcp', (_req: Request, res: Response) => {
    res.writeHead(405).end(methodNotAllowedBody);
  });

  app.listen(port, host, () => {
    console.error(`mcp-oci: MCP HTTP server listening on http://${host}:${port}/mcp`);
    console.error(`mcp-oci: auth mode = ${authMode}, read-only = ${OCI_READ_ONLY}`);
  });
}

async function main() {
  if (MCP_TRANSPORT === 'http') {
    await startHttpServer();
    return;
  }
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error(`mcp-oci: auth mode = ${authMode}, read-only = ${OCI_READ_ONLY}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
