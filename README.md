# bili context · OpenChamber 扩展

在 [OpenChamber](https://docs.openchamber.dev) 侧栏实时显示 [billion-context](https://github.com/ranxianglei/billion-context)（bili）管理的上下文：当前会话上下文占用、缓存命中率、请求/压缩块统计、成本、未命中归因（新内容 / 缓存过期 / 压缩回填）与全局概览。

## 数据链路

```
panel (沙箱 iframe)
  └─ host.serviceRequest()
       └─ 本地 service (宿主以用户权限启动, 仅 127.0.0.1 loopback)
            └─ billion-context 代理 /__bili/* JSON API
```

面板不直接访问网络；service 由 OpenChamber 宿主进程代为拉起并代理请求，端口与 token 均由宿主自动注入，无需配置。

## 安装

1. 克隆或下载本仓库到本地任意目录（**无需构建**，`panel/main.js` 已随仓库提供）：
   ```bash
   git clone https://github.com/SsparKluo/bili-context-openchamber-plugin.git
   ```
2. 打开 OpenChamber → **设置 → 扩展**，粘贴文件夹绝对路径
3. 在批准对话框中确认（面板 + 本地服务）
4. 启动 billion-context 代理（如尚未运行），侧栏即可看到 "bili context" 图标

## 从源码构建（可选）

仅当修改了 `panel/main.ts` 后需要：

```bash
npm install
npm run build   # esbuild → panel/main.js (IIFE)
```

## 端口发现

service 不写死 bili 端口，按以下顺序自动发现（10s 缓存，失败即重读）：

1. `~/.local/state/billion-context/proxy-origin` — 运行中实例记录
2. `~/.local/state/billion-context/port-zone.json` — lane 映射（优先 `opencode` lane）
3. 回退 `http://127.0.0.1:8787` — bili 默认用户区端口

因此 bili 无论配置在哪个端口（含 lane 自管区 18787+）都能跟上，`billion-context.json` 的 `Server.port` 改动无需同步到本插件。

## License

MIT
