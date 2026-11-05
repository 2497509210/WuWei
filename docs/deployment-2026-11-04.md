# 2026-11-04 发布记录

- 当前版本：`2026-11-04-m2.3-tailnet`，北京时间约 22:41 完成；此前物品功能版本 `2026-11-04-m2.2-find` 于 22:28 完成。
- 当前目录：`/opt/wuwei/releases/2026-11-04-m2.3-tailnet`，由 `/opt/wuwei/current` 指向。
- 已连接 Tailscale 时推荐：[空间](https://bd-a.tail3c54de.ts.net/wuwei/) · [家庭找物](https://bd-a.tail3c54de.ts.net/wuwei/find)，使用默认 HTTPS 443，不带 `:8443`。
- 未连接 Tailscale 时使用公网：[空间](https://bd-a.tail3c54de.ts.net:8443/wuwei/) · [家庭找物](https://bd-a.tail3c54de.ts.net:8443/wuwei/find)。

## 发布范围

家庭找物独立页面，现有空间默认入口，分层定位、登记和位置维护、照片、整柜移动、保存与冲突保护、增量迁移、可验证备份与每日计划。箱子搬家和独立空间规划产品未启用。

本次还修正发布脚本：版本与路径校验、原生命令失败即停止、仅打包运行源码、拒绝覆盖旧版本、迁移前备份、启动失败回滚、恢复原 systemd 配置及动态版本号。

## 22:28 物品功能发布核验

- 本地验收：后端 47 项、前端 40 项、备份 10 项；根路径与 `/wuwei` 前缀下各完成 19 项真实 Chrome 流程检查。
- 线上部署预检与冒烟通过，应用及 Funnel 服务 active，公网健康接口和首页正常，未登录接口返回 401。
- 线上后端源码与前端构建的 SHA-256 与本地文件逐项一致。
- `002_items` 已应用，数据库 integrity_check 为 ok，foreign_key_check 无错误。
- 发布前后用户、家庭、楼层、房间、容器、隔层和物品记录数保持一致。
- 应用错误级别日志无新增记录。
- 线上浏览器访问因站点权限被拒绝，未绕过限制；因此本次线上验收为服务器端检查，本地浏览器流程覆盖功能行为。

## 备份

原 m1.2 迁移前备份（保留独立目录）：

`/var/backups/wuwei/predeploy-2026-11-04-m2.1-find/wuwei-20261104T142538-57d36848`

m2.2 发布前备份：

`/var/backups/wuwei/predeploy-2026-11-04-m2.2-find/wuwei-20261104T142856-980028f4`

m2.2 发布后 systemd 备份：

`/var/backups/wuwei/wuwei-20261104T142858-914e9f0b`

`wuwei-backup.service` 返回 success / 0；timer enabled / active。每日 03:15 加最多 15 分钟随机延迟，常规备份保留 14 天。发布时观察到下一次为 2026-11-05 03:23:40 CST，重启或重载后随机执行时间可能调整。

## 22:41 Tailnet 入口更新

发布 `2026-11-04-m2.3-tailnet`，解决本机已连接 Tailscale 时旧公网 8443 入口超时的问题：

- 新增 `wuwei-tailnet.service`，使用 `tailscale serve --bg --https=443 --set-path=/wuwei` 持久配置内网入口，代理至 `127.0.0.1:8790`。
- 保留 443 原有 `/` 到 `127.0.0.1:7863` 的路由，443 仍未开放 Funnel；保留 8443 Funnel `/wuwei` 公网入口，未修改网络 ACL。
- 后端允许来源同时包含 `https://bd-a.tail3c54de.ts.net` 和 `https://bd-a.tail3c54de.ts.net:8443`，应用账号鉴权继续生效。
- 发布脚本、服务模板及预检同步纳入 Tailnet 路由。公网部署预检与冒烟通过；服务器端内网 smoke 全部通过，`wuwei-tailnet.service` enabled / active。
- 本机使用原有代理环境，以及绕过代理、连接 MagicDNS 解析出的 Tailnet 地址 `100.120.80.110` 的 HTTPS 直连检查，内网健康接口均返回 HTTP 200，TLS 验证结果为 0（成功）；本机旧 8443 仍超时，推荐改用无端口链接。
- 本机访问首页和 `/wuwei/find` 的 HTML 及引用的 JS/CSS 均返回 200；`/wuwei/api/items` 未登录返回 401。
- 对登录接口发送空 JSON：无端口 Origin 与 8443 Origin 均返回 422，说明来源校验通过并进入请求字段校验；`https://untrusted.invalid` 返回 403。此检查没有验证真实账号登录成功。
- 本次发布后的首次 systemd 备份成功，每日 timer 保持启用。没有使用真实账号执行登录。
- 新 443 入口的线上浏览器访问也因既有用户拒绝权限被策略阻止，未绕过限制；本次线上结论基于 HTTP、TLS、服务状态及 smoke 检查，不作为线上浏览器验收。

本次部署前已验证的备份：

`/var/backups/wuwei/predeploy-2026-11-04-m2.3-tailnet/wuwei-20261104T144156-1c50cd2b`

## 回滚说明

原版本 `/opt/wuwei/releases/2026-11-03-m1.2` 保留。数据库迁移仅新增字段与表，但旧版没有新的物品保护逻辑；代码回滚后应避免旧版布局写入。恢复迁移前数据库会丢弃其后新增写入，必须先评估并备份当前数据，不能当作无损代码回滚。
