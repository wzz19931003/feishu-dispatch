# 飞书派单运行与升级

配置前确认本地 Node.js 24 或以上。安装依赖使用 `npm ci --omit=dev`。可从 [通用配置模板](../config.workflow.example.json) 开始，凭据、主机名、源表与销售目标字段的标识只保存在本机私有配置 `config.workflow.local.json` 中。每个销售需要独立的个人 Base。

在安装或启用前检查应用权限和文档授权、事件订阅及所有字段映射。运行 `node production-v2/cli.mjs --check` 检查本机配置，运行 `--inspect` 检查云端字段，已有状态库可用 `--plan` 预演派单。预演会读云端并可能在本地增加审计结构。只有生产机可启用顶层 `enabled` 和 `notification.enabled`，同一业务只能运行一个实例。

已有 v2 更新时，先停旧进程并运行 `node production-v2/backup.mjs`。在原目录更新程序文件、保留 `data/workflow.sqlite`，不用重新初始化。v1 迁移时用原 v1 一致备份及原配置核对数据身份，通过 `production-v2/migration.mjs` 写入独立的新库，再做静默基线。发送结果未确认的旧任务进入核查。不要覆盖任何已有状态库，也不要有意用旧状态覆盖已经处理新业务的程序。

上线前用专用测试数据核查分配、个人表和反馈、通知去重、原负责人以及访问边界。参考 [个人表同步](SALES-MIRROR.md) 和 [员工管理](STAFF-MANAGEMENT.md)。
