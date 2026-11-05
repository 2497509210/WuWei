# 房间编辑与账号家庭管理

用户要求继续既定计划，楼层暂不需要。本轮范围：桌面/手机房间名称及尺寸编辑，独立账号与家庭设置页，个人密码/昵称、设备退出、管理员邀请/移除成员，服务器密码恢复工具。沿用已有发布授权，通过测试与备份后上线。楼层数据与既有楼层归属保留，不新增楼层管理入口。

## 交付状态

`2026-11-05-m3.0-accounts` 已于 **2026-11-05 09:03（北京时间）** 发布并完成核验。验证结果：后端 127 项、前端 91 项、备份 10 项通过；Chrome `m2` 19 项、`m3` 10 项、`m4` 14 项通过；生产构建通过。迁移、服务和数据保留证据见 [本轮部署记录](deployment-accounts-2026-11-05.md)。

## 房间

管理员可编辑名称、宽深高，非空名称先 trim；宽深为 100–2000 cm，高为 200–400 cm。房间 `version` 随实际修改增加，新 UI 必带 `expected_version`。旧客户端可暂省略版本；带陈旧版本的编辑返回 409、`room_version_conflict` 和 `current_room`。缩小不得截断容器，无变化的提交不会增加版本。

桌面使用「编辑房间」，手机使用「房间设置 → 编辑房间」。保存成功更新当前房间和导航名称；失败保留输入，版本冲突须明确点击「加载最新房间」后重新修改。房间和同房间容器的写入按序执行，旧读取不能覆盖已保存结果；响应不抢回用户已切换的房间。普通成员只读房间设置，没有新建、编辑或删除房间入口。

## 账号和家庭

- `/settings` 为登录后设置页，从空间及家庭找物顶部「账号」进入；部署前缀下为 `/wuwei/settings`。个人可改昵称、修改密码（验证当前密码并确认新密码），新密码 8–200 字符。修改密码使全部 session/device cookie 失效并返回登录，保留退出原因提示。
- 一次登录产生一个session group，短期session和记住设备token必须关联；退出任一设备组须撤销两者。升级前无法可靠配对的旧token按用户归为一组，并显示“升级前登录（可能包含多台设备）”。当前设备以请求cookie对应的有效组识别。
- 用户只能查看/撤销自己的设备组，也可退出所有设备。列表不返回token/hash或密码。
- 管理员查看成员，生成7天有效、单次使用的邀请码并可撤销；原始码仅创建时返回，数据库保存hash。邀请码由用户自行分享，不自动发送。新成员输入邀请码、用户名、昵称、密码加入，固定member权限；兑换与账号创建在事务中，重复/过期/撤销无效，不泄露家庭信息。
- 移除仅允许本家庭普通成员，禁止移除自己或管理员。成员soft-disable并撤销全部token；保留物品、created_by和历史，不删除其资料记录。被移除者不能登录、续期或持有旧token访问。重新加入需新邀请码与未占用用户名，本轮不实现成员恢复或管理员转让。
- 修改密码与邀请码兑换有节流，变更身份/权限的写操作在事务内重新校验当前会话与角色，防并发撤销后继续写。
- 离线恢复工具通过交互式getpass读取新密码（确认两次），不从参数/日志暴露密码；撤销被重置用户的全部token。仅实现和用临时数据库测试，不修改真实账号密码。

## 忘记密码恢复

服务器已安装管理命令，管理员可运行：

```bash
sudo -u wuwei wuwei-admin reset-password --data-dir /var/lib/wuwei --username 实际用户名
```

替换用户名后按提示输入两次新密码，密码长度为 8–200 字符，不通过命令参数、环境变量或日志传递。命令只针对已存在且未禁用的用户；重置同时撤销该用户的全部登录，不解除成员禁用。部署将包装命令安装至 `/usr/local/bin/wuwei-admin`，从当前 release 调用后端管理入口。服务账户执行 `--help` 已通过；真实账号未用于恢复测试。

## 接口合同

- `PATCH /api/rooms/{id} {expected_version?,name?,width_cm?,depth_cm?,height_cm?,wall_color?}` -> `{room}`，room 含 `version`。新 UI 必传版本，冲突返回 `error.current_room`，前端分型为 `ApiError.currentRoom`。
- `PATCH /api/account/profile {display_name}` -> `{user}`。
- `POST /api/account/password {current_password,new_password}` ->204并清cookie；密码规则沿用8..200字符，当前密码长度1..200。
- `GET /api/account/devices` -> `{devices:[{id,device_name,created_at,last_seen_at,expires_at,current,legacy}]}`。
- `DELETE /api/account/devices/{id}` -> `{current_revoked:boolean}`；`POST /api/account/logout-all` ->204并清cookie。
- `GET /api/household/members` -> `{members:[{id,username,display_name,role,created_at}]}`，仅owner。
- `DELETE /api/household/members/{id}` ->204，禁用普通成员。
- `GET /api/household/invites` -> `{invites:[{id,created_at,expires_at,used_at,revoked_at}]}`，仅owner。
- `POST /api/household/invites` ->201 `{invite:{id,created_at,expires_at,used_at,revoked_at},code:string}`，仅owner。
- `DELETE /api/household/invites/{id}` ->204，幂等撤销，户归属校验。
- `POST /api/auth/join {code,username,display_name,password,remember,device_name?}` ->201 `{user,household}`并设置分组cookie；code最长200，username沿用规则，display_name 1..60 trim；已登录时409拒绝，不能借此隐式切换身份。加入页面为 `/join`，部署前缀下为 `/wuwei/join`，登录页提供入口；兑换成功后的进入页面重试不会再次消耗邀请码。
- 401/403及error结构沿用现有ApiError约定。个人昵称修改后App同步me；密码/全部设备/当前设备撤销成功App清状态、回登录，提示原因。

## 工作分工与验收

`004_accounts` 增加设备组、邀请和成员禁用数据，旧凭据按用户归为 legacy 组；`005_room_version` 为旧房间补版本 1，保留原 ID、名称、尺寸和楼层归属。两项迁移已在隔离数据库测试，并随本轮发布应用到线上。既有数据数量保持、完整性检查通过、外键违规为 0；账号用户名、密码哈希和角色未变，全部旧会话有设备组。代码与资源哈希一致，公网预检与冒烟、Tailnet 设置/加入页面及账号未登录 401 检查通过，发布后备份退出码为 0。真实线上仅只读核验和备份，不生成邀请码、成员或改密码作为测试。

测试已覆盖：短 session 撤销后不能用 remember token 继续登录；权限、家庭归属和管理员保护；密码变更后全部旧 token 失效；邀请仅可兑换一次且失败不消耗；soft-disabled 成员不能登录或续期；并发权限校验；房间版本与尺寸保护、失败草稿、显式冲突刷新、切换房间和容器写入顺序；旧迁移、手机布局和既有找物流程回归。浏览器验收使用临时家庭、账号和物品，不触碰真实业务记录。
