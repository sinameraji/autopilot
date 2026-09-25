/**
 * "Sign in with OpenRouter" panel for onboarding: runs the OAuth PKCE flow
 * (see models/openrouter-oauth.ts) and hands the minted key to `onKey`.
 *
 * Browser mode opens openrouter.ai and catches the redirect on a local port.
 * Code mode (automatic over SSH / on display-less machines, or on request
 * with "c") shows a link to open on any device; OpenRouter then displays a
 * code the user pastes here.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { CustomTextInput } from "./text-input.js";
import { useTheme } from "./theme-context.js";
import { openBrowser } from "./app-helpers.js";
import {
  buildAuthUrl,
  createPkce,
  exchangeCode,
  isHeadlessEnvironment,
  startLoopbackListener,
  type LoopbackListener,
  type Pkce,
} from "../models/openrouter-oauth.js";

interface Props {
  /** Called with the new OpenRouter key once sign-in succeeds. */
  onKey: (key: string) => void;
  /** Esc: back to the previous screen. */
  onBack: () => void;
}

type Mode = "browser" | "code";
type Status = "starting" | "waiting" | "exchanging" | "error";

export function OpenRouterSignIn({ onKey, onBack }: Props) {
  const theme = useTheme();
  const headless = isHeadlessEnvironment();
  const [mode, setMode] = useState<Mode>(headless ? "code" : "browser");
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>("starting");
  const [url, setUrl] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const pkceRef = useRef<Pkce | null>(null);
  const aliveRef = useRef(true);

  const exchange = async (c: string) => {
    const pkce = pkceRef.current;
    if (!pkce || !c.trim()) return;
    setStatus("exchanging");
    setError(null);
    try {
      const key = await exchangeCode(c, pkce.verifier);
      if (aliveRef.current) onKey(key);
    } catch (e) {
      if (!aliveRef.current) return;
      setStatus("error");
      setError((e as Error).message);
      setCode("");
    }
  };

  useEffect(() => {
    aliveRef.current = true;
    let listener: LoopbackListener | null = null;
    const pkce = createPkce();
    pkceRef.current = pkce;
    setStatus("starting");
    setError(null);
    setCode("");
    void (async () => {
      try {
        if (mode === "browser") {
          listener = await startLoopbackListener();
          if (!aliveRef.current) return listener.close();
          const u = buildAuthUrl({ challenge: pkce.challenge, callbackUrl: listener.callbackUrl });
          setUrl(u);
          setOpened(openBrowser(u));
          setStatus("waiting");
          const c = await listener.code;
          if (aliveRef.current) await exchange(c);
        } else {
          const u = buildAuthUrl({ challenge: pkce.challenge });
          setUrl(u);
          // Over SSH the browser is on another machine: just show the link.
          setOpened(headless ? false : openBrowser(u));
          setStatus("waiting");
        }
      } catch (e) {
        if (!aliveRef.current) return;
        setStatus("error");
        setError((e as Error).message);
      }
    })();
    return () => {
      aliveRef.current = false;
      listener?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, attempt]);

  useInput((input, k) => {
    if (k.escape) {
      onBack();
      return;
    }
    // In code mode printable keys belong to the code field; only act on them in browser mode.
    if (mode === "browser" && status !== "exchanging") {
      if (input === "c") setMode("code");
      else if (input === "r") setAttempt((n) => n + 1);
    }
    if (mode === "code" && status === "error" && k.ctrl && input === "r") setAttempt((n) => n + 1);
  });

  const muted = theme.info.color;
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>Sign in with OpenRouter</Text>
      {mode === "browser" ? (
        <Text color={muted} dimColor>
          {opened
            ? "Your browser should now show OpenRouter — approve autopilot there and a key is created for you."
            : "Open this link and approve autopilot — a key is created for you:"}
        </Text>
      ) : (
        <Text color={muted} dimColor>
          {headless ? "This looks like a remote session, so open this link on any device:" : "Open this link on any device:"}{" "}
          approve autopilot, then paste the code OpenRouter shows you.
        </Text>
      )}
      {url && (
        <Box marginTop={1}>
          <Text color={theme.accent}>{url}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        {status === "starting" && <Text color={muted}>preparing…</Text>}
        {status === "exchanging" && <Text color={muted}>finishing sign-in…</Text>}
        {status === "waiting" && mode === "browser" && <Text color={muted}>waiting for you to approve in the browser…</Text>}
        {mode === "code" && (status === "waiting" || status === "error") && (
          <>
            <Text color={theme.palette.primary}>code › </Text>
            <CustomTextInput value={code} onChange={setCode} onSubmit={(v) => void exchange(v)} />
          </>
        )}
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={muted} dimColor>
          {mode === "browser"
            ? `${status === "error" ? "r retry · " : ""}c browser on another device? use a code instead · Esc back`
            : `${status === "error" ? "Ctrl+R new link · " : ""}Enter to submit the code · Esc back`}
        </Text>
      </Box>
    </Box>
  );
}
