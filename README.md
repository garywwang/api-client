# API Client - 接口调试 / 自动化测试 / Mock 一体化工作台

> 一款类 Apifox 的 CodeBuddy / VS Code 扩展。把接口调试、环境 Host 管理、自动化测试、前置/后置脚本、Mock 数据与 Postman / Apifox 导入导出收进同一个工作台，无需在多个工具之间来回切换。

不需要启动额外服务、不需要登录账号，所有数据保存在本地编辑器中，请求由本地扩展宿主直接发出。

![全局](https://raw.githubusercontent.com/wangbin926957/api-client/main/resources/image_1.png)


## 为什么选择 API Client

- **一个窗口完成全流程**：从写请求、切环境、加签名、跑断言到导出分享，不用再开 Postman / Apifox。
- **变量与脚本是原生能力**：`{{变量}}` 直接写在 URL、Header、Body 里；前置脚本生成签名，后置脚本校验响应并提取 token 供后续接口复用。
- **对接现有协作体系**：导出标准 Postman Collection v2.1 或 OpenAPI 3.0，可直接导入 Postman / Apifox；也支持把它们导出的集合再导回来。
- **离线也能联调**：内置本地 Mock HTTP 服务，后端未就绪时前端照样能跑通全链路。
- **轻量无依赖**：运行时零第三方依赖，兼容 VS Code 1.75+ 内核。

## 安装

**方式一：插件市场（推荐）**

在 CodeBuddy / VS Code 扩展面板搜索 `API Client`，点击安装。

**方式二：安装 VSIX**

```bash
code --install-extension vsix/api-client-1.0.11.vsix   # 换成 vsix/ 目录下最新版本
```

或在扩展面板右上角选择「从 VSIX 安装…」，选中 `vsix/` 目录下最新的 `.vsix` 文件。

**方式三：从源码构建**

```bash
cd code
npm install
npm run check     # 语法检查
npm run package   # 生成 vsix/api-client-<version>.vsix
```

> 打包脚本会读取 `package.json` 的 `version` 生成对应文件名，每次升级版本号都会生成新包，不会覆盖历史版本。

## 快速开始

1. 点击活动栏的 **API Client** 图标（或执行命令 `API Client: 打开接口管理`）打开工作台。
2. 在右上角选择环境（内置 `HTTPBin 演示`、`本地 Mock 服务` 等），也可以点齿轮按钮新增自己的 Host。
3. 从左侧接口树选一个示例接口，或点 `+` 新建；在地址栏输入 `{{baseUrl}}/api/path`。
4. 点击 **发送**（或按 `Ctrl/Cmd + Enter`），右侧立即显示状态码、耗时、响应大小、响应头与高亮响应体。
5. 需要分享给同事时，点右上角 **一键导出**，选择 Postman 或 Apifox 格式即可。

## 功能演示

![请求与响应](https://raw.githubusercontent.com/wangbin926957/api-client/main/resources/image_2.png)


## 核心功能

### 1. HTTP 请求调试

- 支持 `GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS`，方法以彩色徽章显示。
- **Params / Body / Headers / Cookies / Auth** 分页编辑；Body 支持 `none`、`form-data`、`x-www-form-urlencoded`、JSON、Text/XML。
- 认证支持 Bearer Token、Basic Auth、API Key（Header 或 Query）。
- 响应区提供 **Pretty / Raw / Preview（JSON 树）/ Table** 四种视图，以及 Header、Cookies、请求控制台；JSON 语法高亮与响应区共用同一套配色。
- 地址栏下方实时显示变量展开后的真实 URL（含 Query 拼装）；引用了未定义变量时会出现波浪线与告警。

### 2. 环境与变量

- 环境数量不限，右上角一个下拉即可随时切换，下拉项直接预览各环境的 `baseUrl`。
- 每套环境可定义任意变量，在 URL、Header、Body、断言期望值中用 `{{key}}` 引用；「全局变量」会被所有环境继承，同名时当前环境优先。
- `{{key}}` 使用专用高亮色，**hover 显示解析值**，未定义变量显示红色波浪线。
- 环境管理弹窗支持新增、复制、删除环境，以及内置变量一键复制。

**内置动态变量（无需定义，全局可用，每次请求重新生成）**

| 变量 | 说明 |
| --- | --- |
| `{{$timestamp}}` | 当前毫秒时间戳 |
| `{{$timestampSec}}` | 当前秒级时间戳 |
| `{{$date}}` | 当前日期 `YYYY-MM-DD` |
| `{{$datetime}}` | ISO 日期时间 |
| `{{$guid}}` / `{{$uuid}}` | 随机 UUID v4（`$guid` 与 Postman 动态变量同名） |
| `{{$randomInt}}` | 0–99999 随机整数 |
| `{{$randomString}}` | 8 位随机字符串 |
| `{{$randomEmail}}` | 随机邮箱 |

同一次请求内多处引用同一个动态变量取值保持一致。

![环境与内置变量](https://raw.githubusercontent.com/wangbin926957/api-client/main/resources/image_3.png)


### 3. 自动化测试

- 为每个接口配置断言：**HTTP 状态码、响应时间、响应体包含、JSONPath 取值、响应头、响应大小**。
- 关系支持等于、不等于、包含、不包含、大于/大于等于、小于/小于等于、存在、非空、正则匹配。
- 支持单接口运行与全量批量运行，生成通过率报告；前置/后置脚本中的 `assert()` 结果也会并入报告。
- `Mock 拦截` 开启时可直接用 Mock 数据跑用例，无需真实后端。

![自动化测试报告](https://raw.githubusercontent.com/wangbin926957/api-client/main/resources/image_4.png)


### 4. 前置操作 / 后置操作（脚本）

在调试区的「前置操作」「后置操作」页签编写 JavaScript，插件已内置可直接启用的注释示例。

- **前置脚本**（请求发出前）：生成 HMAC 签名、时间戳、动态参数，并改写请求。
- **后置脚本**（收到响应后）：解析响应、校验业务码、提取 token 写入环境变量供后续接口使用。
- 脚本在扩展宿主的 `vm` 沙箱中同步执行，单次最长 2 秒，异常会被捕获并显示在「控制台」，不会阻断请求，也不会污染已保存的请求。

**可用 API**

| 分类 | API |
| --- | --- |
| 上下文 | `request`、`env` / `variables`、`response`（仅后置） |
| 工具 | `crypto`、`Buffer`、`JSON`、`Math`、`Date`、编码函数、`console.log` |
| 改写请求 | `setHeader` / `removeHeader` / `setQuery` / `setBody` / `setUrl` |
| 变量 | `setVariable` / `getVariable` |
| 后置校验 | `response.json()`、`response.header(name)`、`assert(condition, message)` |

前置脚本示例（生成签名）：

```js
const secret = env.appSecret || 'demo-secret';
const ts = String(Date.now());
const sign = crypto.createHmac('sha256', secret)
  .update(request.method + '|' + request.url + '|' + ts).digest('hex');
setHeader('X-Timestamp', ts);
setHeader('X-Signature', sign);
setQuery('nonce', '{{$randomString}}');
```

后置脚本示例（校验并提取变量）：

```js
const data = response.json();
assert(response.status === 200, '状态码应为 200');
assert(data.code === 0, '业务码应为 0');
if (data.data && data.data.token) setVariable('token', data.data.token);
```

> 安全提示：脚本在本地受限沙箱中运行，不提供 `require` / `process`；`vm` 并非绝对安全边界，请只运行自己编写或可信来源的脚本。

![前置/后置脚本](https://raw.githubusercontent.com/wangbin926957/api-client/main/resources/image_6.png)


### 5. 临时测试用例

不写入接口树的一次性请求，适合临时调试；支持批量运行、清空，也可一键「保存到接口树」沉淀为正式接口。导出集合时临时用例会一并写入。

### 6. Mock 数据

- 每个接口可配置 Mock 状态码、延迟、响应头与响应体。
- **Mock 拦截**：顶部开关开启后，所有请求直接返回本地 Mock 数据，不发真实网络请求。
- **本地 Mock HTTP 服务**：启动后监听 `127.0.0.1:<port>`，按 Method + Path 匹配已启用 Mock 的接口，外部程序可直接调用；工作台内可查看已注册路由、复制地址，或一键把当前环境 Host 指向它。

![Mock 配置](https://raw.githubusercontent.com/wangbin926957/api-client/main/resources/image_7.png)


### 7. 一键导出与导入

| 格式 | 用途 |
| --- | --- |
| Postman Collection v2.1 | Postman、Apifox 均可直接导入 |
| OpenAPI 3.0 (Swagger) | 通用标准，Apifox / YApi 等可导入 |
| Apifox 优化格式 | 在 OpenAPI 3.0 基础上携带目录、状态与示例 |
| API Client 备份 JSON | 完整保留环境、断言、脚本与 Mock 配置，可无损还原 |

导出时可选择把 `{{变量}}` 展开为当前环境真实值；也可把内容直接复制到剪贴板。前置/后置脚本会写入 Postman 的 `prerequest` / `test` 事件，Apifox 格式则写入 `x-apifox-*` 扩展字段。导入时会自动识别 Postman、OpenAPI/Swagger、Apifox 导出文件及原生备份，并可选择「合并」或「替换」。

![一键导出](https://raw.githubusercontent.com/wangbin926957/api-client/main/resources/image_5.png)


### 8. 编辑体验

- JSON 实时语法校验、错误行号与行号红色标记、「自动格式化」开关、一键格式化。
- Params / Headers 等表格参数名与 JSON key 使用同一套高亮色；括号配对状态随校验显示。
- 请求历史保留最近 100 条记录；项目设置页集中管理超时、Mock 端口、重定向、环境与数据导入导出。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl/Cmd + Enter` | 发送当前请求 |
| `Ctrl/Cmd + S` | 立即保存 |
| `Esc` | 关闭弹窗 / 菜单 |

## 可用命令

| 命令 | 说明 |
| --- | --- |
| `API Client: 打开接口管理` | 打开或聚焦工作台 |
| `API Client: 一键导出所有请求` | 直接打开导出对话框 |
| `API Client: 导入请求集合` | 直接打开文件选择对话框 |

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `apiClient.requestTimeout` | `30000` | 请求超时（毫秒） |
| `apiClient.mockPort` | `38999` | 本地 Mock 服务端口 |
| `apiClient.followRedirects` | `true` | 是否跟随重定向 |

## 兼容性与数据说明

- 兼容 VS Code / CodeBuddy `1.75.0+`，运行时无第三方依赖。
- 接口、环境、脚本、历史等数据保存在编辑器的 `globalState` 中，**不会上传到任何服务器**。
- HTTP 请求由本地扩展宿主直接发出；导出的文件由用户主动选择保存位置。
- 打开工作台后，左侧活动栏图标不会额外占用侧栏窗口，所有入口都集中在工作台内。

## 反馈与贡献

欢迎提交 Issue 或 Pull Request：接口格式兼容问题、新的断言类型、脚本 API、导出格式建议都很欢迎。

提交前请运行：

```bash
cd code
npm run check
npm run package
```

## 开源协议

本项目采用 **MIT License** 开源 © API Client contributors。完整条款见扩展包内的 `LICENSE` 文件。
