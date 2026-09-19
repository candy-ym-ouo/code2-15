# 浮空岛邮政调度员

React 调度面板 + Node.js 权威游戏服务。完整的玩法、规则、接口、运行和验收说明见 [项目文档.md](./项目文档.md)。

信件分拣优先级引擎（确定性排序、可撤销人工覆盖、硬规则保护）的设计说明见 [docs/priority-engine.md](./docs/priority-engine.md)。

```bash
npm install
npm run dev
```

开发模式访问 `http://localhost:5173`，生产模式执行：

```bash
npm run build
npm start
```

然后访问 `http://localhost:3001`。
