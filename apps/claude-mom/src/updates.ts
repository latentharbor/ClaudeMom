/**
 * 自动更新：GitHub Release 上的 latest.json（tauri-action 生成，带签名），由 Tauri updater 校验后安装。
 * 启动时静默查一次；有新版本就在状态栏提示，「Claude 设置 → 版本与更新」里可手动检查与安装。
 */
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from '@tauri-apps/api/core';
import type { ClaudeStatus, CommandResult } from './model';
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { LAB_BUILD } from "./build-mode";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "latest"; version: string }
  | { phase: "available"; version: string; notes: string; update: Update }
  | { phase: "downloading"; version: string; percent: number | null }
  | { phase: "failed"; message: string };

export async function currentVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}

export async function checkForUpdate(): Promise<UpdateState> {
  if (LAB_BUILD) return { phase: "latest", version: await currentVersion() };
  try {
    const update = await check();
    if (!update) return { phase: "latest", version: await currentVersion() };
    return { phase: "available", version: update.version, notes: update.body ?? "", update };
  } catch (cause) {
    return { phase: "failed", message: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** The independent inference service survives the manager's update/relaunch. */
export async function installUpdate(update: Update, onProgress: (percent: number | null) => void): Promise<void> {
  if (LAB_BUILD) throw new Error("The isolated UI lab does not install application updates.");
  const status = await invoke<CommandResult<ClaudeStatus>>('claude_local_status');
  if (status.status !== 'ok') throw new Error('无法确认本地服务状态，请稍后重试更新。');
  if (status.activeDictation) throw new Error('录音仍在进行，请等语音转写完成后更新。');
  if (status.running && !status.serviceIndependent) throw new Error('旧版代理尚未迁移，请先在任务结束后重新启动 Claude。');
  let total = 0;
  let received = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      onProgress(total ? 0 : null);
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      onProgress(total ? Math.min(100, Math.round((received / total) * 100)) : null);
    }
  });
  await relaunch();
}
