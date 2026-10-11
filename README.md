# dsh-plugin-sync

DeepSeek Harness (dsh) 向けの Cordis プラグインです。ローカル環境とリモートサーバ環境の間で、設定ファイル・プロンプト/ルール定義（`AGENTS.md`）・プロファイル構成を安全に同期します。

English summary is available at the bottom of this document.

---

## 主な機能

- **`/sync status`**: SSH接続の死活確認およびローカル側の同期対象ファイル存在チェック
- **`/sync diff`**: ローカルとリモートサーバ上のファイル内容を比較し、差分有無を確認
- **`/sync pull`**: サーバ側の設定をローカルへ取得（既存のローカルファイルはタイムスタンプ付き `.bak` として自動退避）
- **`/sync push`**: ローカルの設定をサーバへ送信（必要なリモートディレクトリを自動生成）
- **`/sync set <remote>`**: リモートSSH接続先アドレスを設定（例: `user@server:~/.dsh`）

---

## 同期対象および除外対象

### 同期対象ファイル
デフォルトで以下の構成ファイルが同期対象となります。
- `settings.yaml.imported`
- `settings.yaml`
- `AGENTS.md`
- `profiles/dsh-tui/package.json`
- `profiles/dsh-tui/cordis.patch.yml`
- `profiles/web/package.json`
- `profiles/web/cordis.patch.yml`
- `profiles/headless/package.json`
- `profiles/headless/cordis.patch.yml`

### 同期除外（セキュリティ保護）
機密情報やセッション履歴の漏洩・上書きを防ぐため、以下は意図的に同期対象外としています。
- `sessions/`（チャット履歴）
- `.credentials.yaml`（APIキーおよび認証資格情報）
- プラグイン内部設定ファイル（`plugins/dsh-sync/config.json` 等）

---

## 前提条件

- Node.js (ES Modules 対応環境)
- ローカル環境に OpenSSH クライアント（`ssh`, `scp` コマンド）が導入され、PATH が通っていること
- リモートサーバへの公開鍵認証などによるパスワードレス SSH 接続が設定されていること

---

## インストールと設定

### 1. 配置
`~/.dsh/plugins/` ディレクトリ配下に本プラグインを配置またはシンボリックリンクを作成します。

```bash
cd ~/.dsh/plugins
git clone https://github.com/puyokura/dsh-plugin-sync.git
```

### 2. 設定ファイルの作成
`config.example.json` をコピーして `config.json` を作成するか、dsh 起動後に `/sync set` コマンドで設定します。

```bash
cd ~/.dsh/plugins/dsh-plugin-sync
cp config.example.json config.json
```

`config.json` の内容例:
```json
{
  "remote": "user@server:~/.dsh"
}
```

※ `config.json` には接続先ホスト情報が含まれるため、Git リポジトリにはコミットされません（`.gitignore` 指定済）。

### 3. dsh プロファイルへの登録
各プロファイル（例: `profiles/dsh-tui/cordis.patch.yml`）または Cordis 設定ファイルにプラグインを追加します。

```yaml
plugins:
  dsh-plugin-sync:
    # 必要に応じてオプションを指定
```

---

## コマンド一覧

dsh のチャット入力欄からスラッシュコマンドとして実行します。

| コマンド | 説明 |
| :--- | :--- |
| `/sync help` | コマンドの使い方および現在の同期先を表示 |
| `/sync status` | リモートサーバへのSSH疎通および対象ファイル状態を確認 |
| `/sync diff` | ローカルとサーバ間のファイルの差分行数や有無を確認 |
| `/sync pull` | サーバ側のファイルをローカルへ反映（ローカルファイルは `.bak` 退避） |
| `/sync push` | ローカルのファイルをサーバへ反映 |
| `/sync set <remote>` | サーバ接続先アドレスを更新（例: `user@hostname:~/.dsh`） |

---

## English Summary

`dsh-plugin-sync` is a Cordis plugin for DeepSeek Harness (dsh) that synchronizes configurations, prompt rules (`AGENTS.md`), and profile definitions between local and server environments via SSH/SCP.

### Key Features
- `/sync status`: Inspect SSH connectivity and local file existence.
- `/sync diff`: Compare configuration files between local and remote server.
- `/sync pull`: Download remote files to local with automated timestamped `.bak` backups.
- `/sync push`: Upload local files to remote server safely.
- `/sync set <remote>`: Update remote SSH connection target (e.g., `user@server:~/.dsh`).

Sensitive data such as `.credentials.yaml` and conversation logs (`sessions/`) are excluded from synchronization to ensure security.

---

## ライセンス

MIT License (c) 2026 puyokura
