import type { McpDiscoveredTool, McpParameterSummary, McpPermissionLevel, McpRisk, McpToolAnnotations } from "@dnafix/contracts";

export interface ReviewedClassification {
  level: McpPermissionLevel;
  reviewed: boolean;
  rationale: string;
}

const READ_ONLY = new Set([
  "list_containers",
  "inspect_container",
  "container_list",
  "container_inspect",
  "list_images",
  "inspect_image",
  "image_list",
  "image_inspect",
  "image_history",
  "list_networks",
  "inspect_network",
  "network_list",
  "network_inspect",
  "list_volumes",
  "inspect_volume",
  "volume_list",
  "volume_inspect",
  "list_nodes",
  "inspect_node",
  "node_list",
  "node_inspect",
  "list_services",
  "inspect_service",
  "service_list",
  "service_inspect",
  "list_tasks",
  "inspect_task",
  "task_list",
  "task_inspect",
  "list_contexts",
  "inspect_context",
  "context_list",
  "context_inspect",
  "list_plugins",
  "inspect_plugin",
  "plugin_list",
  "plugin_inspect",
  "list_configs",
  "inspect_config",
  "config_list",
  "config_inspect",
  "get_system_info",
  "system_info",
  "docker_version",
  "version",
  "info",
  "ps",
  "images",
  "logs",
  "container_logs",
  "inspect",
  "events",
  "top",
  "stats",
  "port",
  "df",
  "search_images",
  "image_search",
  "search",
  "list_builds",
  "inspect_build",
]);

const WORKSPACE = new Set([
  "create_container",
  "container_create",
  "start_container",
  "container_start",
  "stop_container",
  "container_stop",
  "restart_container",
  "container_restart",
  "exec_container",
  "container_exec",
  "run_container",
  "container_run",
  "build_image",
  "image_build",
  "pull_image",
  "image_pull",
  "tag_image",
  "image_tag",
  "copy_to_container",
  "copy_from_container",
  "container_copy",
  "cp",
  "commit_container",
  "container_commit",
  "create_volume",
  "volume_create",
  "build",
  "pull",
  "tag",
  "load_image",
  "save_image",
  "image_load",
  "image_save",
  "export_container",
  "container_export",
  "update_container",
  "container_update",
  "rename_container",
  "container_rename",
  "pause_container",
  "container_pause",
  "unpause_container",
  "container_unpause",
]);

const DESTRUCTIVE = new Set([
  "remove_container",
  "container_remove",
  "rm",
  "kill_container",
  "container_kill",
  "remove_image",
  "image_remove",
  "rmi",
  "remove_volume",
  "volume_remove",
  "prune_containers",
  "container_prune",
  "prune_images",
  "image_prune",
  "prune_networks",
  "network_prune",
  "prune_volumes",
  "volume_prune",
  "prune_system",
  "system_prune",
  "prune",
  "create_network",
  "network_create",
  "remove_network",
  "network_remove",
  "connect_network",
  "network_connect",
  "disconnect_network",
  "network_disconnect",
  "run_privileged_container",
  "create_privileged_container",
  "privileged_container",
  "mount_host_path",
  "host_mount",
  "add_host_mount",
  "update_daemon",
  "daemon_config",
  "config_update",
  "list_secrets",
  "get_secret",
  "inspect_secret",
  "create_secret",
  "remove_secret",
  "secret_list",
  "secret_inspect",
  "secret_create",
  "secret_remove",
  "push_image",
  "image_push",
  "login",
  "logout",
  "context_use",
  "context_create",
  "context_remove",
  "plugin_install",
  "plugin_remove",
  "plugin_enable",
  "plugin_disable",
  "swarm_init",
  "swarm_leave",
  "node_update",
  "node_remove",
  "service_update",
  "service_remove",
  "service_create",
  "stack_deploy",
  "stack_remove",
  "stack_rm",
  "system_reset",
  "factory_reset",
]);

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isDockerTool(serverName: string, toolName: string): boolean {
  const server = normalizeKey(serverName);
  const tool = normalizeKey(toolName);
  return server.includes("docker") || server.includes("gateway") || tool.startsWith("docker_") || tool.startsWith("mcp_docker_");
}

function candidateKeys(serverName: string, toolName: string): string[] {
  const server = normalizeKey(serverName);
  let tool = normalizeKey(toolName);
  const keys = new Set<string>([tool]);
  for (const prefix of ["docker_", "mcp_docker_", "mcp_"]) {
    if (tool.startsWith(prefix)) {
      tool = tool.slice(prefix.length);
      keys.add(tool);
    }
  }
  if (server && tool.startsWith(`${server}_`)) keys.add(tool.slice(server.length + 1));
  // Gateway names sometimes separate server and tool with a double underscore.
  const parts = tool.split("__");
  if (parts.length === 2 && parts[1]) keys.add(parts[1]);
  return [...keys];
}

/**
 * Explicit reviewed policy. Descriptions and arbitrary server hints are never
 * used to decide risk. Anything not listed here is unreviewed and defaults to
 * Level 3, disabled until a human reviews it.
 */
export function classifyTool(serverName: string, toolName: string, annotations?: McpToolAnnotations | null): ReviewedClassification {
  if (!isDockerTool(serverName, toolName)) {
    return {
      level: 3,
      reviewed: false,
      rationale: "Server is not covered by the reviewed Docker Desktop policy; human review is required.",
    };
  }
  const keys = candidateKeys(serverName, toolName);
  const destructiveHint = annotations?.destructiveHint === true;
  let matched: { level: McpPermissionLevel; key: string } | null = null;
  for (const key of keys) {
    if (READ_ONLY.has(key)) {
      matched = { level: 1, key };
      break;
    }
  }
  if (!matched) {
    for (const key of keys) {
      if (WORKSPACE.has(key)) {
        matched = { level: 2, key };
        break;
      }
    }
  }
  if (!matched) {
    for (const key of keys) {
      if (DESTRUCTIVE.has(key)) {
        matched = { level: 3, key };
        break;
      }
    }
  }

  if (destructiveHint && matched?.level !== 3) {
    return {
      level: 3,
      reviewed: true,
      rationale: `Reviewed policy ${matched ? `(${matched.key})` : ""} was escalated to Level 3 by the server's destructive-hint annotation.`,
    };
  }
  if (matched) {
    return {
      level: matched.level,
      reviewed: true,
      rationale:
        matched.level === 1
          ? `Reviewed read-only policy entry '${matched.key}'.`
          : matched.level === 2
            ? `Reviewed workspace policy entry '${matched.key}'.`
            : `Reviewed destructive policy entry '${matched.key}'.`,
    };
  }
  return {
    level: 3,
    reviewed: false,
    rationale: "Tool is not in the reviewed policy; defaults to Level 3 and stays disabled until a human reviews it.",
  };
}

export function riskForLevel(level: McpPermissionLevel): McpRisk {
  return level === 1 ? "low" : level === 2 ? "medium" : "high";
}

export function permissionLabel(level: McpPermissionLevel): string {
  return level === 1 ? "Level 1 · Read-only" : level === 2 ? "Level 2 · Workspace / run-scoped" : "Level 3 · Destructive or host-wide";
}

export function consequencesFor(level: McpPermissionLevel, tool: McpDiscoveredTool): string {
  if (level === 1) return "Read-only operation. It cannot modify containers, images, volumes, networks, or host files.";
  if (level === 2) {
    return "Creates or modifies resources scoped to this run. It requires an explicit run-level workspace grant and is audited.";
  }
  return `Destructive or host-wide operation (${tool.serverName}/${tool.name}). It can delete resources, modify host configuration, or act outside the run workspace. It requires per-call human approval and is never reused for another invocation.`;
}

const TARGET_KEYS = [
  "container",
  "containerId",
  "container_id",
  "id",
  "name",
  "image",
  "volume",
  "network",
  "path",
  "hostPath",
  "host_path",
  "source",
  "target",
  "command",
  "cmd",
];

/** Human-readable target derived only from validated arguments. */
export function describeTarget(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of TARGET_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) parts.push(`${key}=${value.trim().slice(0, 160)}`);
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) parts.push(`${key}=${value.join(" ").slice(0, 160)}`);
  }
  return parts.length > 0 ? parts.join(", ") : "(no explicit target in arguments)";
}

export function parameterSummary(inputSchema: Record<string, unknown>): McpParameterSummary[] {
  const properties = inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required.filter((v): v is string => typeof v === "string") : []);
  return Object.entries(properties as Record<string, unknown>)
    .slice(0, 40)
    .map(([name, raw]) => {
      const schema = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const type =
        typeof schema.type === "string"
          ? schema.type
          : Array.isArray(schema.type)
            ? schema.type.filter((v): v is string => typeof v === "string").join("|")
            : schema.enum
              ? "enum"
              : "unknown";
      return {
        name,
        type,
        required: required.has(name),
        description: typeof schema.description === "string" ? schema.description.slice(0, 300) : null,
      };
    });
}
