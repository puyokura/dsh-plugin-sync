/**
 * @module dsh-plugin-sync
 * Cordis plugin for DeepSeek Harness (dsh) to synchronize configs,
 * prompts/rules, and profiles between local and server environments.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'sync'
export const inject = ['commands']

const DEFAULT_SYNC_FILES = [
  'settings.yaml.imported',
  'settings.yaml',
  'AGENTS.md',
  'profiles/dsh-tui/package.json',
  'profiles/dsh-tui/cordis.patch.yml',
  'profiles/web/package.json',
  'profiles/web/cordis.patch.yml',
  'profiles/headless/package.json',
  'profiles/headless/cordis.patch.yml',
]

/** Get dsh home directory (~/.dsh) */
function getDshHome() {
  return process.env.DSH_HOME || path.join(process.env.HOME || process.env.USERPROFILE, '.dsh')
}

/** Get plugin config path */
function getPluginConfigPath() {
  return path.join(getDshHome(), 'plugins', 'dsh-sync', 'config.json')
}

/** Read plugin configuration */
function readConfig() {
  const configPath = getPluginConfigPath()
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch {
      return {}
    }
  }
  return {}
}

/** Save plugin configuration */
function saveConfig(cfg) {
  const configPath = getPluginConfigPath()
  const dir = path.dirname(configPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
}

/** Parse SSH remote target (e.g., user@server:~/.dsh or server:.dsh) */
function parseRemote(target) {
  if (!target || !target.includes(':')) {
    throw new Error('Format must be: user@host:/path/to/.dsh (e.g. agent:~/.dsh)')
  }
  const [host, remotePath] = target.split(':', 2)
  return { host, remotePath: remotePath || '~/.dsh' }
}

/** Execute a command safely */
async function runCmd(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || '',
      error: err.message,
    }
  }
}


/** Core sync operations */
export async function executeSyncAction(action, targetRemote) {
  const config = readConfig()
  const remote = targetRemote || config.remote
  const dshHome = getDshHome()
  const syncFiles = config.files || DEFAULT_SYNC_FILES

  if (action === 'set') {
    if (!targetRemote) return { ok: false, error: 'Remote address required (e.g. agent:~/.dsh)' }
    parseRemote(targetRemote)
    config.remote = targetRemote
    saveConfig(config)
    return { ok: true, message: `Remote sync target updated to: ${targetRemote}` }
  }

  if (action === 'status') {
    if (!remote) {
      return { ok: false, error: 'Remote target is not set. Run "/sync set agent:~/.dsh" first.' }
    }
    const { host } = parseRemote(remote)
    const probe = await runCmd('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, 'echo OK'])
    const sshOk = probe.ok && probe.stdout.includes('OK')

    const files = syncFiles.map((rel) => {
      const full = path.join(dshHome, rel)
      return { file: rel, exists: fs.existsSync(full) }
    })
    const existingCount = files.filter((f) => f.exists).length

    return {
      ok: true,
      remote,
      sshOk,
      sshError: sshOk ? null : (probe.stderr || probe.error || 'Failed'),
      files,
      existingCount,
      totalCount: files.length,
    }
  }

  if (action === 'push') {
    if (!remote) return { ok: false, error: 'Remote target not set. Run "/sync set agent:~/.dsh" first.' }
    const { host, remotePath } = parseRemote(remote)
    const remoteDirs = new Set(syncFiles.map((f) => path.dirname(f)).filter((d) => d && d !== '.'))

    if (remoteDirs.size > 0) {
      const dirList = Array.from(remoteDirs).map((d) => `${remotePath}/${d}`).join(' ')
      const mkdirRes = await runCmd('ssh', [host, `mkdir -p ${dirList}`])
      if (!mkdirRes.ok) {
        return { ok: false, error: `Failed to create remote dirs: ${mkdirRes.stderr || mkdirRes.error}` }
      }
    }

    const results = []
    let successCount = 0
    for (const rel of syncFiles) {
      const localFile = path.join(dshHome, rel)
      if (!fs.existsSync(localFile)) {
        results.push({ file: rel, status: 'SKIP' })
        continue
      }
      const remoteDest = `${host}:${remotePath}/${rel}`
      const scpRes = await runCmd('scp', [localFile, remoteDest])
      if (scpRes.ok) {
        results.push({ file: rel, status: 'OK' })
        successCount++
      } else {
        results.push({ file: rel, status: 'FAIL', error: scpRes.stderr || scpRes.error })
      }
    }
    return { ok: true, remote, successCount, totalCount: syncFiles.length, results }
  }

  if (action === 'pull') {
    if (!remote) return { ok: false, error: 'Remote target not set. Run "/sync set agent:~/.dsh" first.' }
    const { host, remotePath } = parseRemote(remote)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const results = []
    let successCount = 0

    for (const rel of syncFiles) {
      const localFile = path.join(dshHome, rel)
      const localDir = path.dirname(localFile)
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true })

      let backedUp = false
      if (fs.existsSync(localFile)) {
        try {
          fs.copyFileSync(localFile, `${localFile}.${timestamp}.bak`)
          backedUp = true
        } catch {}
      }

      const remoteSrc = `${host}:${remotePath}/${rel}`
      const scpRes = await runCmd('scp', [remoteSrc, localFile])
      if (scpRes.ok) {
        results.push({ file: rel, status: 'OK', backedUp })
        successCount++
      } else {
        results.push({ file: rel, status: 'FAIL', error: scpRes.stderr || scpRes.error })
      }
    }
    return { ok: true, remote, successCount, totalCount: syncFiles.length, results }
  }

  if (action === 'diff') {
    if (!remote) return { ok: false, error: 'Remote target not set. Run "/sync set agent:~/.dsh" first.' }
    const { host, remotePath } = parseRemote(remote)
    const expandedRemotePath = remotePath.startsWith('~') ? `$HOME${remotePath.slice(1)}` : remotePath
    const results = []

    for (const rel of syncFiles) {
      const localFile = path.join(dshHome, rel)
      const localExists = fs.existsSync(localFile)

      const remoteCmd = `if [ -f ${expandedRemotePath}/${rel} ]; then cat ${expandedRemotePath}/${rel}; else echo "__DSH_SYNC_NOT_FOUND__"; fi`
      const remoteRes = await runCmd('ssh', [host, remoteCmd])
      if (!remoteRes.ok) {
        results.push({ file: rel, status: 'ERROR', error: remoteRes.stderr || remoteRes.error })
        continue
      }

      const remoteExists = !remoteRes.stdout.includes('__DSH_SYNC_NOT_FOUND__')
      const remoteContent = remoteExists ? remoteRes.stdout : null
      const localContent = localExists ? fs.readFileSync(localFile, 'utf8') : null

      if (!localExists && !remoteExists) {
        continue
      }
      if (localExists && !remoteExists) {
        results.push({ file: rel, status: 'LOCAL_ONLY' })
      } else if (!localExists && remoteExists) {
        results.push({ file: rel, status: 'REMOTE_ONLY' })
      } else {
        const normLocal = localContent.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').trim()
        const normRemote = remoteContent.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').trim()
        if (normLocal === normRemote) {
          results.push({ file: rel, status: 'IDENTICAL' })
        } else {
          results.push({
            file: rel,
            status: 'DIFF',
            localLines: normLocal.split('\n').length,
            remoteLines: normRemote.split('\n').length,
          })
        }
      }
    }
    return { ok: true, remote, results }
  }

  return { ok: false, error: `Unknown action: ${action}` }
}

/** Formatter for chat timeline output */
function formatHelp(remote) {
  return [
    '### dsh 設定同期 (`/sync`)',
    '',
    '| コマンド | 説明 |',
    '| :--- | :--- |',
    '| `/sync status` | 接続状況と同期対象ファイルの確認 |',
    '| `/sync diff` | サーバとローカルの設定差分を確認 |',
    '| `/sync pull` | サーバの設定をローカルへ取得 (バックアップ自動作成) |',
    '| `/sync push` | ローカルの設定をサーバへ送信 |',
    '| `/sync set <remote>` | サーバ接続先を変更 (例: `agent:~/.dsh`) |',
    '',
    `- **現在の接続先**: \`${remote || '(未設定)'}\``,
    '- **同期対象**: `settings.yaml`, `AGENTS.md`, 各プロファイルの `package.json` / `cordis.patch.yml`',
    '- **同期除外**: `sessions/` (会話履歴), `.credentials.yaml` (APIキー)',
  ].join('\n')
}

function formatStatus(res, dshHome) {
  const fileRows = res.files.map((f) => `| \`${f.file}\` | ${f.exists ? 'OK (存在)' : '未検出 (SKIP)'} |`)
  return [
    '### 同期ステータス (`/sync status`)',
    '',
    `- **ローカル**: \`${dshHome}\``,
    `- **リモート**: \`${res.remote}\``,
    `- **SSH接続**: ${res.sshOk ? '正常 (接続成功)' : `接続失敗 (${res.sshError})`}`,
    '',
    '| 対象ファイル | ローカル状態 |',
    '| :--- | :--- |',
    ...fileRows,
    '',
    `> 同期状態: ${res.existingCount}/${res.totalCount} ファイル存在`,
  ].join('\n')
}

function formatPull(res) {
  const rows = res.results.map((r) => {
    const status = r.status === 'OK' ? `成功${r.backedUp ? ' (.bak作成済)' : ''}` : `失敗 (${r.error})`
    return `| \`${r.file}\` | ${status} |`
  })
  return [
    '### サーバからの取得完了 (`/sync pull`)',
    '',
    `- **取得元**: \`${res.remote}\``,
    `- **結果**: ${res.successCount}/${res.totalCount} ファイル反映完了`,
    '',
    '| ファイル | 状態 |',
    '| :--- | :--- |',
    ...rows,
    '',
    '> 既存ファイルは `.bak` として自動保存されました。',
  ].join('\n')
}

function formatDiff(res) {
  const rows = res.results.map((r) => {
    let statStr = ''
    if (r.status === 'IDENTICAL') statStr = '一致 (差分なし)'
    else if (r.status === 'DIFF') statStr = `**差分あり** (Local: ${r.localLines}行 / Remote: ${r.remoteLines}行)`
    else if (r.status === 'LOCAL_ONLY') statStr = 'ローカルのみ存在'
    else if (r.status === 'REMOTE_ONLY') statStr = 'サーバのみ存在'
    else if (r.status === 'ERROR') statStr = `エラー (${r.error})`
    return `| \`${r.file}\` | ${statStr} |`
  })
  return [
    '### サーバとの差分確認 (`/sync diff`)',
    '',
    `- **リモート**: \`${res.remote}\``,
    '',
    '| 対象ファイル | 比較結果 |',
    '| :--- | :--- |',
    ...rows,
    '',
    '> 差分をローカルへ反映する場合は `/sync pull`、サーバへ反映する場合は `/sync push` を実行してください。',
  ].join('\n')
}

function formatPush(res) {
  const rows = res.results.map((r) => {
    const status = r.status === 'OK' ? '成功' : (r.status === 'SKIP' ? 'スキップ (未検出)' : `失敗 (${r.error})`)
    return `| \`${r.file}\` | ${status} |`
  })
  return [
    '### サーバへの反映完了 (`/sync push`)',
    '',
    `- **送信先**: \`${res.remote}\``,
    `- **結果**: ${res.successCount}/${res.totalCount} ファイル送信完了`,
    '',
    '| ファイル | 状態 |',
    '| :--- | :--- |',
    ...rows,
    '',
    '> プラグイン追加時は、必要に応じてサーバ側で `pnpm install` を実行してください。',
  ].join('\n')
}

/** Register plugin in dsh */
export function apply(ctx) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: 'dsh-plugin-sync',
      name: 'sync',
      description: 'Sync dsh configs with server (/sync help | status | pull | push | set)',
      handler: async (invocation) => {
        const args = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
        const sub = args[0]?.toLowerCase() || 'help'
        const subarg = args.slice(1).join(' ')
        const dshHome = getDshHome()
        const config = readConfig()

        let chatText = ''

        if (sub === 'help') {
          chatText = formatHelp(config.remote)
        } else if (sub === 'set' || sub === 'remote') {
          const res = await executeSyncAction('set', subarg)
          chatText = res.ok
            ? `### 同期先設定の更新\n\n- **リモート先**: \`${subarg}\`\n- **状態**: 保存完了`
            : `### 設定エラー\n\n${res.error}`
        } else if (sub === 'status') {
          const res = await executeSyncAction('status')
          chatText = res.ok ? formatStatus(res, dshHome) : `### 同期ステータス エラー\n\n${res.error}`
        } else if (sub === 'diff') {
          const res = await executeSyncAction('diff')
          chatText = res.ok ? formatDiff(res) : `### 差分確認エラー\n\n${res.error}`
        } else if (sub === 'pull') {
          const res = await executeSyncAction('pull')
          chatText = res.ok ? formatPull(res) : `### 取得エラー\n\n${res.error}`
        } else if (sub === 'push') {
          const res = await executeSyncAction('push')
          chatText = res.ok ? formatPush(res) : `### 送信エラー\n\n${res.error}`
        } else {
          chatText = `### 未知のコマンド\n\n\`/sync ${sub}\` は存在しません。\`/sync help\` を確認してください。`
        }

        return {
          kind: 'success',
          text: chatText,
        }
      },
    })
  }, 'dsh-plugin-sync command')
}
