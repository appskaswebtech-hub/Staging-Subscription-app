import prisma from "../db.server";

export type ShopifyAdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type GraphqlEnvelope<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

type MoneyV2 = {
  amount?: string | null;
  currencyCode?: string | null;
};

type SubscriptionLineNode = {
  id?: string | null;
  title?: string | null;
  quantity?: number | null;
  sellingPlanName?: string | null;
  currentPrice?: MoneyV2 | null;
};

type SubscriptionContractNode = {
  id: string;
  status?: string | null;
  nextBillingDate?: string | null;
  customer?: {
    id?: string | null;
    email?: string | null;
  } | null;
  billingPolicy?: {
    interval?: string | null;
    intervalCount?: number | null;
  } | null;
  lines?: {
    edges?: Array<{ node?: SubscriptionLineNode | null }>;
  } | null;
};

type SubscriptionContractsConnection = {
  subscriptionContracts?: {
    edges?: Array<{ node?: SubscriptionContractNode | null }>;
    pageInfo?: {
      hasNextPage?: boolean | null;
      endCursor?: string | null;
    } | null;
  } | null;
};

type SingleSubscriptionContract = {
  subscriptionContract?: SubscriptionContractNode | null;
};

type SubscriptionWebhookPayload = Record<string, any>;

const CONTRACTS_QUERY = `#graphql
  query GetSubscriptionContracts($first: Int!, $after: String) {
    subscriptionContracts(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          status
          nextBillingDate
          customer {
            id
            email
          }
          billingPolicy {
            interval
            intervalCount
          }
          lines(first: 10) {
            edges {
              node {
                id
                title
                quantity
                sellingPlanName
                currentPrice {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    }
  }
`;

const CONTRACT_BY_ID_QUERY = `#graphql
  query GetSubscriptionContract($id: ID!) {
    subscriptionContract(id: $id) {
      id
      status
      nextBillingDate
      customer {
        id
        email
      }
      billingPolicy {
        interval
        intervalCount
      }
      lines(first: 10) {
        edges {
          node {
            id
            title
            quantity
            sellingPlanName
            currentPrice {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

function parseAmount(value: unknown): number {
  const amount =
    typeof value === "number"
      ? value
      : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN;

  return Number.isFinite(amount) ? amount : 0;
}

function toCustomerGid(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  return value.startsWith("gid://")
    ? value
    : `gid://shopify/Customer/${value}`;
}

function parseNextBillingDate(raw?: string | null): Date {
  const parsed = raw ? new Date(raw) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

function getContractLines(
  contract: SubscriptionContractNode,
): SubscriptionLineNode[] {
  return (contract.lines?.edges ?? [])
    .map((edge) => edge.node)
    .filter((line): line is SubscriptionLineNode => Boolean(line));
}

function getPayloadLines(payload: SubscriptionWebhookPayload): Array<Record<string, any>> {
  if (Array.isArray(payload.lines)) return payload.lines;
  if (Array.isArray(payload.line_items)) return payload.line_items;
  return [];
}

function getPayloadLinePrice(line: Record<string, any>): number {
  return parseAmount(
    line.currentPrice?.amount ??
      line.current_price?.amount ??
      line.current_price ??
      line.price ??
      line.line_price,
  );
}

function buildPayloadUpsertData(shop: string, payload: SubscriptionWebhookPayload) {
  const contractId = payload.admin_graphql_api_id
    ? String(payload.admin_graphql_api_id)
    : toContractGid(payload.subscription_contract_id ?? payload.id ?? "");
  const lines = getPayloadLines(payload);
  const firstLine = lines[0] ?? null;
  const price = lines.reduce((sum, line) => {
    const quantity = Number.isFinite(line.quantity) ? Number(line.quantity) : 1;
    return sum + getPayloadLinePrice(line) * quantity;
  }, 0);

  return {
    shop,
    shopifyContractId: contractId,
    customerId: toCustomerGid(
      payload.admin_graphql_api_customer_id ??
        payload.customer?.admin_graphql_api_id ??
        payload.customer?.id ??
        payload.customer_id,
    ),
    customerEmail: String(
      payload.customer?.email ??
        payload.customer_email ??
        "",
    ),
    productTitle: String(
      firstLine?.title ??
        firstLine?.product_title ??
        payload.title ??
        "Unknown Product",
    ),
    planName: String(
      firstLine?.sellingPlanName ??
        firstLine?.selling_plan_name ??
        firstLine?.selling_plan?.name ??
        "Subscription",
    ),
    status: normaliseStatus(payload.status),
    price,
    frequency: normaliseFrequency(
      payload.billingPolicy?.interval ?? payload.billing_policy?.interval,
      payload.billingPolicy?.intervalCount ??
        payload.billing_policy?.interval_count ??
        1,
    ),
    nextBillingDate: parseNextBillingDate(
      payload.nextBillingDate ?? payload.next_billing_date,
    ),
  };
}

function buildContractUpsertData(shop: string, contract: SubscriptionContractNode) {
  const lines = getContractLines(contract);
  const firstLine = lines[0] ?? null;
  const price = lines.reduce((sum, line) => {
    const quantity = Number.isFinite(line.quantity) ? Number(line.quantity) : 1;
    return sum + parseAmount(line.currentPrice?.amount) * quantity;
  }, 0);

  return {
    shop,
    shopifyContractId: contract.id,
    customerId: String(contract.customer?.id ?? ""),
    customerEmail: String(contract.customer?.email ?? ""),
    productTitle: String(firstLine?.title ?? "Unknown Product"),
    planName: String(firstLine?.sellingPlanName ?? "Subscription"),
    status: normaliseStatus(contract.status),
    price,
    frequency: normaliseFrequency(
      contract.billingPolicy?.interval,
      contract.billingPolicy?.intervalCount,
    ),
    nextBillingDate: parseNextBillingDate(contract.nextBillingDate),
  };
}

async function ensureInitialBillingAttempt(
  subscriptionId: string,
  amount: number,
  status: string,
) {
  if (status === "CANCELLED" || amount <= 0) return;

  const attemptCount = await prisma.billingAttempt.count({
    where: { subscriptionId },
  });

  if (attemptCount === 0) {
    await prisma.billingAttempt.create({
      data: {
        subscriptionId,
        amount,
        status: "SUCCESS",
      },
    });
  }
}

async function upsertSubscriptionData(
  data: ReturnType<typeof buildContractUpsertData>,
) {
  if (!data.shopifyContractId) return null;

  const subscription = await prisma.subscription.upsert({
    where: { shopifyContractId: data.shopifyContractId },
    update: {
      shop: data.shop,
      customerId: data.customerId,
      customerEmail: data.customerEmail,
      productTitle: data.productTitle,
      planName: data.planName,
      status: data.status,
      price: data.price,
      frequency: data.frequency,
      nextBillingDate: data.nextBillingDate,
    },
    create: data,
  });

  await ensureInitialBillingAttempt(subscription.id, data.price, data.status);
  return subscription;
}

async function parseGraphqlResult<T>(
  response: Response,
): Promise<T> {
  const result = (await response.json()) as GraphqlEnvelope<T>;

  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join(" | "));
  }

  return (result.data ?? {}) as T;
}

export function toContractGid(raw: string | number): string {
  const id = String(raw ?? "").trim();
  if (!id) return "";
  return id.startsWith("gid://")
    ? id
    : `gid://shopify/SubscriptionContract/${id}`;
}

export function normaliseStatus(raw?: string | null): string {
  const map: Record<string, string> = {
    ACTIVE: "ACTIVE",
    PAUSED: "PAUSED",
    CANCELLED: "CANCELLED",
    EXPIRED: "CANCELLED",
    FAILED: "CANCELLED",
  };

  return map[String(raw ?? "").toUpperCase()] ?? "PENDING";
}

export function normaliseFrequency(
  interval?: string | null,
  count?: number | null,
): string {
  if (!interval) return "MONTHLY";

  const unit = interval.toUpperCase();
  const safeCount = Number.isFinite(count) && Number(count) > 0 ? Number(count) : 1;

  if (unit === "DAY") return safeCount > 1 ? `${safeCount} DAILY` : "DAILY";
  if (unit === "WEEK") {
    if (safeCount === 1) return "WEEKLY";
    if (safeCount === 2) return "BIWEEKLY";
    return `${safeCount} WEEKLY`;
  }
  if (unit === "MONTH") return safeCount > 1 ? `${safeCount} MONTHLY` : "MONTHLY";
  if (unit === "YEAR") return safeCount > 1 ? `${safeCount} YEARLY` : "YEARLY";

  return "MONTHLY";
}

export async function fetchSubscriptionContractById(
  admin: ShopifyAdminClient,
  contractId: string,
): Promise<SubscriptionContractNode | null> {
  const data = await parseGraphqlResult<SingleSubscriptionContract>(
    await admin.graphql(CONTRACT_BY_ID_QUERY, {
      variables: { id: toContractGid(contractId) },
    }),
  );

  return data.subscriptionContract ?? null;
}

export async function syncSubscriptionFromPayload(
  shop: string,
  payload: SubscriptionWebhookPayload,
) {
  const data = buildPayloadUpsertData(shop, payload);
  if (!data.shopifyContractId) return null;
  return upsertSubscriptionData(data);
}

export async function syncSubscriptionContractById(
  admin: ShopifyAdminClient,
  shop: string,
  contractId: string,
) {
  const contract = await fetchSubscriptionContractById(admin, contractId);
  if (!contract) return null;
  return upsertSubscriptionData(buildContractUpsertData(shop, contract));
}

export async function syncSubscriptionsFromShopify(
  admin: ShopifyAdminClient,
  shop: string,
  options?: { pageSize?: number; maxPages?: number },
) {
  const pageSize = Math.min(options?.pageSize ?? 100, 250);
  const maxPages = options?.maxPages ?? 10;
  const synced: NonNullable<Awaited<ReturnType<typeof upsertSubscriptionData>>>[] = [];
  let after: string | null = null;
  let page = 0;

  while (page < maxPages) {
    const data: SubscriptionContractsConnection =
      await parseGraphqlResult<SubscriptionContractsConnection>(
      await admin.graphql(CONTRACTS_QUERY, {
        variables: { first: pageSize, after },
      }),
    );

    const connection: SubscriptionContractsConnection["subscriptionContracts"] =
      data.subscriptionContracts ?? null;
    const edges = connection?.edges ?? [];

    for (const edge of edges) {
      if (!edge.node) continue;
      const subscription = await upsertSubscriptionData(
        buildContractUpsertData(shop, edge.node),
      );
      if (subscription) synced.push(subscription);
    }

    const hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    const endCursor: string | null = connection?.pageInfo?.endCursor ?? null;

    if (!hasNextPage || !endCursor) break;

    after = endCursor;
    page += 1;
  }

  return synced;
}
