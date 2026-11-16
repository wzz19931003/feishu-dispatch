# Feishu Dispatch

飞书多维表格派单工具。它根据销售顺序和启用状态分配客资，把该客资同步到负责人自己的表，并通过飞书应用发送通知。可选的员工管理表支持新的人员开通、启停和调序。运行环境为 Windows x64、Node.js 24 或以上及飞书企业自建应用。

## 已有 v2 项目升级

从 [GitHub Releases](https://github.com/wzz19931003/feishu-dispatch/releases) 获取安装包。升级目标是已初始化并配置好的 v2 项目目录。运行安装包前核对发行说明、发布签名与摘要。准备一个维护窗口并保留一份当前一致备份。安装器核对旧进程，备份后只换程序文件，保留本机私有配置和数据库。新程序启动结果不明确时，保留更新现场及诊断记录，先确认状态再处理。

新接入用户需要准备自己的飞书企业应用、客资表、每名销售的个人表和应用可用范围。将 [工作流模板](config.workflow.example.json) 复制到部署电脑，填入实际字段及资源映射并保持开关关闭，先完整跑完 [配置与验收步骤](production-v2/README.md)。本项目不能把飞书的表单或视图过滤变成文档访问控制，权限须在所属企业单独验证。

可选的 [员工管理表配置](production-v2/STAFF-MANAGEMENT.md) 使用自行准备的资源。模板使用空的标识及示例姓名，私有配置、应用密钥、人员标识、客户记录和运行数据库请留在受控的部署环境中。

## 开发与验证

`npm ci` 安装已锁定的依赖，`npm test` 执行隔离测试。测试使用合成人员及行记录、假飞书客户端和临时 SQLite。真实权限、消息收件与计划任务须在目标环境另行验证。

## 构建与发行

发布密钥保存在代码库外受控目录。首次配置发行者并构建通用更新包和引导安装包：

```powershell
$repository = 'owner/name' # 换成你管理的 GitHub 仓库
$publisher = '..\feishu-dispatch-signing'
node desktop-installer/release.mjs key --repository $repository --out $publisher
node desktop-installer/release.mjs build --repository $repository --key (Join-Path $publisher 'publisher.private.pem') --out '..\feishu-dispatch-release'
node desktop-installer/build.mjs --out '..\feishu-dispatch-setup' --channel (Join-Path $publisher 'channel.json')
```

发行标签与代码中的版本一致。将 `manifest.json`、`manifest.sig`、`feishu-dispatch-update.zip` 及通用安装包上传同一版本发布页。更新客户端凭渠道绑定的 Ed25519 公钥验证签名与摘要，GitHub HTTPS 用于下载分发。`channel.json` 包含仓库和公钥，私钥始终留在发布者手中。

公开构建省略 `--binding` 参数。若另给自有企业生成带绑定的安装包，可在本地构建时另行传入 `--binding <私有员工资源文件>`，通过企业受控渠道分发。公共发行物只包含通用资产。

本项目使用 [MIT License](LICENSE)。
