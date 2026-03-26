# 腾讯镜像站的skill管理器

这是一个基于 Node.js 的 Skill 管理 CLI，用于在本地搜索、安装、升级和查看技能（skills）。

## 为什么要重构

腾讯镜像站原始版本对 Windows 兼容性不完整，尤其依赖 Python 的执行链路在部分 Windows 环境下会出现以下问题：

- 命令无法正常启动
- 进程无输出直接退出
- 需要额外安装并配置 Python 才能使用

为了解决这些问题，我将核心逻辑从 Python 全量重构为 JavaScript（Node.js），目标是：

- 在 Windows 上开箱即用
- 去除 Python 运行时依赖
- 保持原有功能：search / install / upgrade / list / self-upgrade

## 环境要求

- Node.js >= 18（建议）
- npm >= 9

## 安装与运行

### 方式一：直接用 npx（推荐）

```bash
npx skillhub-cli-tencent --help
```

### 方式二：全局安装

```bash
npm i -g skillhub-cli-tencent
skillhub --help
```

## 使用方式

### 1) 查看帮助

```bash
skillhub --help
```

### 2) 搜索技能

```bash
skillhub search prompt
skillhub search prompt engineer
skillhub search prompt --json
```

### 3) 安装技能

```bash
skillhub install find-skills
```

常用参数：

- `--force`：覆盖已存在目录
- `--workdir <path>`：指定工作目录
- `--dir <path>`：指定安装根目录

示例：

```bash
skillhub install find-skills --force
skillhub install find-skills --workdir ./workspace --dir skills
```

### 4) 查看本地已安装技能

```bash
skillhub list
skillhub list --workdir ./workspace --dir skills
```

### 5) 升级技能

```bash
# 升级全部
skillhub upgrade

# 只检查，不安装
skillhub upgrade --check-only

# 升级指定技能
skillhub upgrade find-skills
```

### 6) 升级 CLI 自身

```bash
# 只检查版本
skillhub self-upgrade --check-only

# 执行自升级
skillhub self-upgrade
```

## 路径与配置说明

- 默认工作目录优先级：
  1. `SKILLHUB_WORKDIR` 环境变量
  2. OpenClaw workspace 配置
  3. 当前目录

- 默认安装目录优先级：
  1. `SKILLHUB_INSTALL_DIR` 环境变量
  2. `<workdir>/skills`

- 已安装技能清单保存在安装根目录下：
  - `.skills_store_lock.json`

## 本地开发

```bash
npm install
node ./skillhub-bin.js --help
```

## License

MIT
