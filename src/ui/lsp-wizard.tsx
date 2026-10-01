import React, { useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { spawn } from "node:child_process";
import { useTheme } from "./theme-context.js";
import type { Theme } from "./theme.js";
import type { LspServerConfig } from "../config.js";
import { getShellCommand } from "../tools/bash.js";
import { CustomTextInput } from "./text-input.js";

export interface Preset {
  id: string;
  name: string;
  description: string;
  command: string[];
  installCommand: string;
  installHint: string;
}

export const PRESETS: Preset[] = [
  {
    id: "typescript",
    name: "TypeScript",
    description: "TypeScript and JavaScript support",
    command: ["typescript-language-server", "--stdio"],
    installCommand: "npm install -g typescript-language-server typescript",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "python",
    name: "Python (Pyright)",
    description: "Python type checking and IntelliSense",
    command: ["pyright-langserver", "--stdio"],
    installCommand: "npm install -g pyright",
    installHint: "Requires Node.js and npm (alternative: pip install pyright)",
  },
  {
    id: "rust",
    name: "Rust",
    description: "Rust analyzer for Rust code",
    command: ["rust-analyzer"],
    installCommand: "rustup component add rust-analyzer",
    installHint: "Requires Rust toolchain (rustup)",
  },
  {
    id: "go",
    name: "Go",
    description: "Go language server (gopls)",
    command: ["gopls"],
    installCommand: "go install golang.org/x/tools/gopls@latest",
    installHint: "Requires Go toolchain",
  },
  {
    id: "json",
    name: "JSON",
    description: "JSON language support",
    command: ["vscode-json-language-server", "--stdio"],
    installCommand: "npm install -g vscode-langservers-extracted",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "css",
    name: "CSS",
    description: "CSS/SCSS/Less language support",
    command: ["vscode-css-language-server", "--stdio"],
    installCommand: "npm install -g vscode-langservers-extracted",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "html",
    name: "HTML",
    description: "HTML language support",
    command: ["vscode-html-language-server", "--stdio"],
    installCommand: "npm install -g vscode-langservers-extracted",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "eslint",
    name: "ESLint",
    description: "JavaScript/TypeScript linting",
    command: ["vscode-eslint-language-server", "--stdio"],
    installCommand: "npm install -g vscode-langservers-extracted",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "docker",
    name: "Dockerfile",
    description: "Dockerfile language support",
    command: ["docker-langserver", "--stdio"],
    installCommand: "npm install -g dockerfile-language-server-nodejs",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "yaml",
    name: "YAML",
    description: "YAML language support",
    command: ["yaml-language-server", "--stdio"],
    installCommand: "npm install -g yaml-language-server",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "bash",
    name: "Bash",
    description: "Bash shell script support",
    command: ["bash-language-server", "start"],
    installCommand: "npm install -g bash-language-server",
    installHint: "Requires Node.js and npm",
  },
  {
    id: "lua",
    name: "Lua",
    description: "Lua language support",
    command: ["lua-language-server"],
    installCommand: "brew install lua-language-server  (macOS) or see https://luals.github.io",
    installHint: "Install varies by platform — see https://luals.github.io",
  },
  {
    id: "custom",
    name: "Custom",
    description: "Enter your own language server command",
    command: [],
    installCommand: "",
    installHint: "You will enter the command manually",
  },
];

type Page = "main" | "add" | "install" | "custom-name" | "custom-command" | "scope" | "edit" | "delete" | "list";

interface Props {
  servers: Record<string, LspServerConfig>;
  currentScope: "project" | "global";
  hasProjectDir: boolean;
  onDone: () => void;
  onSave: (servers: Record<string, LspServerConfig>, enabled: boolean, scope: "project" | "global") => void;
}

interface InstallState {
  status: "idle" | "running" | "success" | "error";
  output: string;
}

export function LspWizard({ servers, currentScope, hasProjectDir, onDone, onSave }: Props) {
  const theme = useTheme();
  const [page, setPage] = useState<Page>("main");
  const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null);
  const [customName, setCustomName] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [installState, setInstallState] = useState<InstallState>({ status: "idle", output: "" });
  const [pendingServers, setPendingServers] = useState<Record<string, LspServerConfig> | null>(null);
  const [pendingEnabled, setPendingEnabled] = useState<boolean>(true);

  const runInstall = (command: string) => {
    setInstallState({ status: "running", output: "Installing..." });

    const { shell, args } = getShellCommand();
    const child = spawn(shell, [...args, command], {
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (code === 0) {
        setInstallState({ status: "success", output: stdout || "Installed successfully." });
      } else {
        setInstallState({ status: "error", output: stderr || stdout || `Exit code: ${code}` });
      }
    });

    child.on("error", (err) => {
      setInstallState({ status: "error", output: err.message });
    });
  };

  const handleAddPreset = (preset: Preset) => {
    if (preset.id === "custom") {
      setPage("custom-name");
      return;
    }
    setSelectedPreset(preset);
    setInstallState({ status: "idle", output: "" });
    setPage("install");
  };

  const handleConfirmInstall = () => {
    if (!selectedPreset) return;
    if (selectedPreset.installCommand) {
      runInstall(selectedPreset.installCommand);
    } else {
      setInstallState({ status: "success", output: "No install command needed." });
    }
  };

  const handleSavePreset = () => {
    if (!selectedPreset) return;
    const next = {
      ...servers,
      [selectedPreset.id]: {
        command: selectedPreset.command,
        enabled: true,
      },
    };
    setPendingServers(next);
    setPendingEnabled(true);
    setPage("scope");
  };

  const handleSaveCustom = () => {
    const name = customName.trim();
    const cmd = customCommand.trim();
    if (!name || !cmd) return;
    const next = {
      ...servers,
      [name]: {
        command: cmd.split(/\s+/),
        enabled: true,
      },
    };
    setPendingServers(next);
    setPendingEnabled(true);
    setPage("scope");
  };

  const handleDelete = (key: string) => {
    const next = { ...servers };
    delete next[key];
    onSave(next, Object.keys(next).length > 0, currentScope);
    setPage("main");
  };

  const handleToggle = (key: string) => {
    const next = {
      ...servers,
      [key]: { ...servers[key]!, enabled: !servers[key]!.enabled },
    };
    onSave(next, true, currentScope);
  };

  const handleScopeSelect = (scope: "project" | "global") => {
    if (pendingServers) {
      onSave(pendingServers, pendingEnabled, scope);
    }
    setPendingServers(null);
    setSelectedPreset(null);
    setCustomName("");
    setCustomCommand("");
    setInstallState({ status: "idle", output: "" });
    setPage("main");
  };

  const mainItems = [
    { label: "Add server", value: "add", key: "add" },
    { label: "Edit server", value: "edit", key: "edit" },
    { label: "Delete server", value: "delete", key: "delete" },
    { label: "List servers", value: "list", key: "list" },
    { label: "(close)", value: "__close__", key: "__close__" },
  ];

  // ─── Main menu ─────────────────────────────────────────────────────────────

  if (page === "main") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent} bold>
          LSP Servers
        </Text>
        <Text color={theme.info.color} dimColor={false}>
          Arrow keys to navigate, Enter to select.
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={mainItems}
            onSelect={(item) => {
              if (item.value === "__close__") {
                onDone();
              } else {
                setPage(item.value as Page);
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  // ─── Add ───────────────────────────────────────────────────────────────────

  if (page === "add") {
    const items = [
      ...PRESETS.map((p) => {
        const already = p.id in servers;
        const marker = already ? " · configured" : "";
        return {
          label: `${p.name.padEnd(20)} ${p.description}${marker}`,
          value: p.id,
          key: p.id,
        };
      }),
      { label: "← Back", value: "__back__", key: "__back__" },
    ];

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent} bold>
          Add LSP Server
        </Text>
        <Text color={theme.info.color} dimColor={false}>
          Select a language server to configure.
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === "__back__") {
                setPage("main");
              } else {
                const preset = PRESETS.find((p) => p.id === item.value);
                if (preset) handleAddPreset(preset);
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  // ─── Install ───────────────────────────────────────────────────────────────

  if (page === "install" && selectedPreset) {
    const isRunning = installState.status === "running";
    const isDone = installState.status === "success" || installState.status === "error";
    const isSuccess = installState.status === "success";

    const items = !isDone
      ? [
          { label: isRunning ? "Installing..." : "Run install command", value: "run", key: "run" },
          { label: "Skip install (already installed)", value: "skip", key: "skip" },
          { label: "← Back", value: "__back__", key: "__back__" },
        ]
      : [
          { label: isSuccess ? "Save to config ✓" : "Save anyway", value: "save", key: "save" },
          { label: "← Back", value: "__back__", key: "__back__" },
        ];

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent} bold>
          Install {selectedPreset.name}
        </Text>
        <Text color={theme.info.color} dimColor={false}>
          {selectedPreset.installHint}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.info.color} dimColor={false}>
            Command:
          </Text>
          <Text color={theme.accent}>{selectedPreset.installCommand || "(none required)"}</Text>
        </Box>

        {installState.output && (
          <Box marginTop={1} flexDirection="column">
            <Text color={isSuccess ? theme.accent : theme.error}>
              {installState.output.slice(-500)}
            </Text>
          </Box>
        )}

        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === "__back__") {
                setPage("add");
                setInstallState({ status: "idle", output: "" });
              } else if (item.value === "run" && !isRunning) {
                handleConfirmInstall();
              } else if (item.value === "skip") {
                setInstallState({ status: "success", output: "Skipped install." });
              } else if (item.value === "save") {
                handleSavePreset();
              }
            }}
          />
        </Box>

        {isSuccess && (
          <Box marginTop={1}>
            <Text color={theme.accent}>
              Server saved. Run /lsp reload to start it.
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // ─── Custom name ───────────────────────────────────────────────────────────

  if (page === "custom-name") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent} bold>
          Custom LSP Server — Name
        </Text>
        <Text color={theme.info.color} dimColor={false}>
          Enter a name for this server (e.g., my-server).
        </Text>
        <Box marginTop={1}>
          <Text color={theme.accent}>› </Text>
          <CustomTextInput
            value={customName}
            onChange={setCustomName}
            onSubmit={(value) => {
              if (value.trim()) {
                setCustomName(value.trim());
                setPage("custom-command");
              }
            }}
          />
        </Box>
        <Box marginTop={1}>
          <SelectInput
            items={[{ label: "← Back", value: "__back__", key: "__back__" }]}
            onSelect={() => setPage("add")}
          />
        </Box>
      </Box>
    );
  }

  // ─── Custom command ────────────────────────────────────────────────────────

  if (page === "custom-command") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent} bold>
          Custom LSP Server — Command
        </Text>
        <Text color={theme.info.color} dimColor={false}>
          Enter the command to start the server (space-separated).
        </Text>
        <Box marginTop={1}>
          <Text color={theme.accent}>› </Text>
          <CustomTextInput
            value={customCommand}
            onChange={setCustomCommand}
            onSubmit={(value) => {
              if (value.trim()) {
                setCustomCommand(value.trim());
                handleSaveCustom();
              }
            }}
          />
        </Box>
        <Box marginTop={1}>
          <SelectInput
            items={[{ label: "← Back", value: "__back__", key: "__back__" }]}
            onSelect={() => setPage("custom-name")}
          />
        </Box>
      </Box>
    );
  }

  // ─── Scope ─────────────────────────────────────────────────────────────────

  if (page === "scope") {
    const defaultToProject = hasProjectDir || currentScope === "project";
    const items = [
      {
        label: defaultToProject ? "This project only (· current)" : "This project only",
        value: "project",
        key: "project",
      },
      {
        label: defaultToProject ? "Global config" : "Global config (· current)",
        value: "global",
        key: "global",
      },
      { label: "← Back", value: "__back__", key: "__back__" },
    ];

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent} bold>
          Save LSP Config
        </Text>
        <Text color={theme.info.color} dimColor={false}>
          Where should this server configuration be saved?
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === "__back__") {
                setPage("main");
                setPendingServers(null);
              } else {
                handleScopeSelect(item.value as "project" | "global");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  // ─── Edit ──────────────────────────────────────────────────────────────────

  if (page === "edit") {
    const keys = Object.keys(servers);
    if (keys.length === 0) {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text color={theme.accent} bold>
            Edit LSP Server
          </Text>
          <Text color={theme.info.color}>No servers configured.</Text>
          <Box marginTop={1}>
            <SelectInput
              items={[{ label: "← Back", value: "__back__", key: "__back__" }]}
              onSelect={() => setPage("main")}
            />
          </Box>
        </Box>
      );
    }

    const items = [
      ...keys.map((k) => {
        const s = servers[k]!;
        const status = s.enabled !== false ? "enabled" : "disabled";
        return {
          label: `${k.padEnd(16)} ${status}  ${s.command.join(" ")}`,
          value: k,
          key: k,
        };
      }),
      { label: "← Back", value: "__back__", key: "__back__" },
    ];

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent} bold>
          Edit LSP Server
        </Text>
        <Text color={theme.info.color} dimColor={false}>
          Select a server to toggle enabled/disabled.
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === "__back__") {
                setPage("main");
              } else {
                handleToggle(item.value);
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  // ─── Delete ────────────────────────────────────────────────────────────────

  if (page === "delete") {
    const keys = Object.keys(servers);
    if (keys.length === 0) {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text color={theme.accent} bold>
            Delete LSP Server
          </Text>
          <Text color={theme.info.color}>No servers configured.</Text>
          <Box marginTop={1}>
            <SelectInput
              items={[{ label: "← Back", value: "__back__", key: "__back__" }]}
              onSelect={() => setPage("main")}
            />
          </Box>
        </Box>
      );
    }

    const items = [
      ...keys.map((k) => ({
        label: `${k.padEnd(16)} ${servers[k]!.command.join(" ")}`,
        value: k,
        key: k,
      })),
      { label: "← Back", value: "__back__", key: "__back__" },
    ];

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent} bold>
          Delete LSP Server
        </Text>
        <Text color={theme.info.color} dimColor={false}>
          Select a server to remove from config.
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === "__back__") {
                setPage("main");
              } else {
                handleDelete(item.value);
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  // ─── List ──────────────────────────────────────────────────────────────────

  if (page === "list") {
    const keys = Object.keys(servers);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent} bold>
          Configured LSP Servers
        </Text>
        {keys.length === 0 ? (
          <Text color={theme.info.color}>No servers configured.</Text>
        ) : (
          <Box marginTop={1} flexDirection="column">
            {keys.map((k) => {
              const s = servers[k]!;
              const status = s.enabled !== false ? "enabled" : "disabled";
              return (
                <Text key={k} color={theme.info.color}>
                  {`  ${k.padEnd(16)} ${status}  ${s.command.join(" ")}`}
                </Text>
              );
            })}
          </Box>
        )}
        <Box marginTop={1}>
          <SelectInput
            items={[{ label: "← Back", value: "__back__", key: "__back__" }]}
            onSelect={() => setPage("main")}
          />
        </Box>
      </Box>
    );
  }

  return null;
}
