import { json } from "@remix-run/node";
import { useLoaderData, useNavigation, Form } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";

// ─── TYPES ───────────────────────────────────────────────────────────────────

type SellingPlanGroup = {
  id: string;
  name: string;
};

type DeleteResult = {
  id: string;
  name: string;
  success: boolean;
  error?: string;
};

type LoaderData = {
  groups: SellingPlanGroup[];
  error?: string;
};

type ActionData = {
  results: DeleteResult[];
  totalDeleted: number;
  totalFailed: number;
};

// ─── LOADER — fetch all selling plan groups ───────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`
    query GetAllSellingPlanGroups {
      sellingPlanGroups(first: 50) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `);

  const data = await response.json();

  if (data.errors) {
    return json<LoaderData>({
      groups: [],
      error: data.errors[0]?.message ?? "Failed to fetch selling plan groups",
    });
  }

  const groups: SellingPlanGroup[] =
    data.data.sellingPlanGroups.edges.map(
      ({ node }: { node: SellingPlanGroup }) => ({
        id: node.id,
        name: node.name,
      })
    );

  return json<LoaderData>({ groups });
}

// ─── ACTION — delete all selling plan groups ──────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  // Step 1: Fetch all groups
  const listResponse = await admin.graphql(`
    query GetAllSellingPlanGroups {
      sellingPlanGroups(first: 50) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `);

  const listData = await listResponse.json();
  const groups: SellingPlanGroup[] =
    listData.data.sellingPlanGroups.edges.map(
      ({ node }: { node: SellingPlanGroup }) => node
    );

  const results: DeleteResult[] = [];

  // Step 2: Delete each group
  for (const group of groups) {
    try {
      const deleteResponse = await admin.graphql(
        `
        mutation DeleteSellingPlanGroup($id: ID!) {
          sellingPlanGroupDelete(id: $id) {
            deletedSellingPlanGroupId
            userErrors {
              field
              message
            }
          }
        }
      `,
        { variables: { id: group.id } }
      );

      const deleteData = await deleteResponse.json();
      const userErrors =
        deleteData.data?.sellingPlanGroupDelete?.userErrors ?? [];

      if (userErrors.length > 0) {
        results.push({
          id: group.id,
          name: group.name,
          success: false,
          error: userErrors.map((e: { message: string }) => e.message).join(", "),
        });
      } else {
        results.push({
          id: group.id,
          name: group.name,
          success: true,
        });
      }
    } catch (err) {
      results.push({
        id: group.id,
        name: group.name,
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const totalDeleted = results.filter((r) => r.success).length;
  const totalFailed = results.filter((r) => !r.success).length;

  return json<ActionData>({ results, totalDeleted, totalFailed });
}

// ─── UI ───────────────────────────────────────────────────────────────────────

export default function AdminCleanup() {
  const { groups, error } = useLoaderData<LoaderData>();
  const actionData = useNavigation().state === "idle"
    ? undefined
    : undefined;
  const navigation = useNavigation();
  const isDeleting = navigation.state === "submitting";

  // We need to use useFetcher or useActionData for action results
  return <CleanupPage groups={groups} error={error} isDeleting={isDeleting} />;
}

function CleanupPage({
  groups,
  error,
  isDeleting,
}: {
  groups: SellingPlanGroup[];
  error?: string;
  isDeleting: boolean;
}) {
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>🧹 Selling Plan Groups Cleanup</h1>
        <p style={styles.subtitle}>
          This will permanently delete all selling plan groups from your store.
        </p>

        {error && (
          <div style={styles.errorBox}>
            <strong>Error:</strong> {error}
          </div>
        )}

        <div style={styles.infoBox}>
          <strong>Found {groups.length} selling plan group(s):</strong>
          {groups.length === 0 ? (
            <p style={{ marginTop: 8, color: "#6b7280" }}>
              No selling plan groups found. Nothing to delete.
            </p>
          ) : (
            <ul style={styles.list}>
              {groups.map((g) => (
                <li key={g.id} style={styles.listItem}>
                  <span style={styles.groupName}>{g.name}</span>
                  <span style={styles.groupId}>{g.id}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {groups.length > 0 && (
          <Form method="post">
            <button
              type="submit"
              disabled={isDeleting}
              style={{
                ...styles.button,
                opacity: isDeleting ? 0.6 : 1,
                cursor: isDeleting ? "not-allowed" : "pointer",
              }}
            >
              {isDeleting
                ? "⏳ Deleting all groups..."
                : `🗑️ Delete All ${groups.length} Group(s)`}
            </button>
          </Form>
        )}

        <p style={styles.warning}>
          ⚠️ <strong>Warning:</strong> This action is irreversible. Remove this
          route from your app after use.
        </p>
      </div>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    backgroundColor: "#f9fafb",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: "12px",
    padding: "32px",
    maxWidth: "640px",
    width: "100%",
    boxShadow: "0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)",
  },
  title: {
    fontSize: "24px",
    fontWeight: 700,
    color: "#111827",
    marginBottom: "8px",
  },
  subtitle: {
    fontSize: "14px",
    color: "#6b7280",
    marginBottom: "24px",
  },
  infoBox: {
    backgroundColor: "#f3f4f6",
    borderRadius: "8px",
    padding: "16px",
    marginBottom: "24px",
    fontSize: "14px",
    color: "#374151",
  },
  errorBox: {
    backgroundColor: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: "8px",
    padding: "12px 16px",
    marginBottom: "16px",
    fontSize: "14px",
    color: "#dc2626",
  },
  list: {
    marginTop: "12px",
    paddingLeft: "0",
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  listItem: {
    display: "flex",
    flexDirection: "column",
    backgroundColor: "#fff",
    borderRadius: "6px",
    padding: "8px 12px",
    border: "1px solid #e5e7eb",
  },
  groupName: {
    fontWeight: 600,
    color: "#111827",
    fontSize: "14px",
  },
  groupId: {
    fontSize: "11px",
    color: "#9ca3af",
    marginTop: "2px",
    fontFamily: "monospace",
  },
  button: {
    backgroundColor: "#dc2626",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    padding: "12px 24px",
    fontSize: "14px",
    fontWeight: 600,
    width: "100%",
    marginBottom: "16px",
  },
  warning: {
    fontSize: "12px",
    color: "#92400e",
    backgroundColor: "#fffbeb",
    border: "1px solid #fde68a",
    borderRadius: "6px",
    padding: "10px 14px",
  },
};
