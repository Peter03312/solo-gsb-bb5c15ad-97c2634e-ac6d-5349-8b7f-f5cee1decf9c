# 🌿 PhytoMeasure · 植物显微切片测量 Web 应用

在浏览器中上传植物显微切片图片，完成像素—微米定标后，圈选多个细胞的外轮廓及其孔洞，
自动计算**扣除孔洞后的净面积（μm²）**与**含孔洞边界的总周长（μm）**；
还可圈定多个**命名取样视野**（外环 + 可选孔洞），按细胞净区域质心统计各视野的
**细胞数、净面积（mm²）与每 mm² 细胞密度**；并可对**同一草稿/报告内至少两个视野**
按其净区域**几何并集**查看**合并统计**（并集面积、去重细胞数、密度与计入净面积总和）；
可发布为不可变报告、导出**标注 PNG**、**测量 CSV** 与**视野统计 CSV**；
并支持把一份已发布报告的全部细胞经**三点对应仿射变换**整体迁移到另一张切片草稿。

- 技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 原生 Canvas 前端
- 图片与数据**全部本地保存**（无任何外部服务依赖）：
  - 数据库：`data/app.db`
  - 原始图片：`data/images/`
  - 发布时的图片快照：`data/snapshots/`
  - 标注 PNG / CSV 在导出时实时生成

## 功能说明

1. **图片上传**：支持 PNG / JPEG / WebP（≤ 30 MB），读取真实像素尺寸。
2. **标尺定标**：在原图上点选**两个不同的像素点**，输入它们的实际微米距离，
   得到每像素微米数（μm/px）。两点重合、坐标越界、距离非正数均会被拒绝，且整次修改不生效。
3. **细胞轮廓**：可圈选多个细胞外轮廓，每个细胞可包含多个孔洞。
   - 轮廓不得**自交/自接触**，顶点不得**越出图片**；
   - 孔洞必须**严格位于**所属外轮廓内部（不能贴着外轮廓边界）；
   - 同一细胞的孔洞之间**不得接触或重叠**；
   - 任意一个对象不合法时，服务端会指出具体细胞/孔洞编号与原因，**整批轮廓保存不生效**。
4. **测量结果**：
   - 净面积 =（外轮廓面积 − 全部孔洞面积）× (μm/px)²，单位 **μm²**；
   - 总周长 =（外轮廓周长 + 全部孔洞周长）× μm/px，单位 **μm**；
   - 缩放、平移视图只改变显示，不改变任何测量值。
5. **重新定标**：草稿中的所有轮廓立即按新比例重算测量值，所有视野统计同步重算。
6. **取样视野 · 细胞密度统计**：可在同一张切片上圈定**多个命名视野**，每个视野由
   一个不自交外环与**可选孔洞**构成（孔洞必须严格位于外环内、彼此不得接触或重叠）。
   - 归属规则：以每个细胞**扣除孔洞后的净区域质心**判定——质心**严格**落在某视野净区域
     （严格在外环内、且不在视野孔洞内/边界上）才计入；落在**边界不计入**；
   - 视野之间**允许重叠**，重叠处的细胞在每个视野中**分别计数（可重复计数）**；
   - **净面积为零的细胞**没有良定义质心，不计入任何视野；
   - **已定标**时展示各视野：净面积（**mm²**）、细胞数、**每 mm² 细胞密度**、
     计入细胞的净面积总和（mm²）；**未定标**时保留视野与细胞数，面积/密度/总和显示
     **「待定标」**；
   - 细胞轮廓变动、视野变动或重新定标后统计**自动重算**；
   - 整批原子保存：视野越界、自交、孔洞不严格位于外环内或彼此接触重叠、净面积非正时
     **整批视野保存不生效**，服务端指出具体视野编号与原因；
   - 视野保存同样走草稿乐观版本号，版本过期返回 HTTP 409，页面自动拉取最新草稿。
7. **发布与乐观并发**：
   - 发布会冻结当时的**图片副本、标尺、细胞轮廓、取样视野与全部统计结果**（含视野密度统计），
     之后修改草稿（含删除/重画视野）不影响已发布报告；
   - 发布请求必须携带**读取时的草稿版本号**；期间草稿被改动（版本过期）时请求被拒绝（HTTP 409），
     页面会自动拉取最新草稿，需确认后重新发布。
8. **导出**：在「已发布报告」页勾选报告，可导出
   - 单份或多份合并的**测量 CSV**（UTF-8 BOM，Excel 直接可读，含义保持不变）；
   - 单份报告的**视野统计 CSV**（与报告页表格为**同一份冻结结果**；旧报告无视野时仅表头+空提示）；
   - 单份**标注 PNG**（彩色细胞轮廓、红色虚线孔洞、细胞编号与青色标尺）；
   - 多份报告的 **ZIP**（每份一张标注 PNG + 一份 CSV，外附汇总 CSV）。
9. **报告比较（基线 ↔ 复测）**：在「报告比较」页选择**两份不同**的已发布报告，
   先点基线侧一个细胞、再点复测侧一个细胞，**手动**建立一对一配对
   （**同名细胞不会自动配对**；已配对细胞从两侧待选列表移除，可随时「解除」）。
   - 比较只读取两份报告**冻结的定标与测量值**：每对细胞给出净面积、总周长的
     **两侧数值、带符号差值（复测 − 基线）与相对基线变化率**；未配对细胞在两侧分别列出。
   - 基线值为 **0** 时变化率显示 / 导出为 **「不可计算」**（差值仍给出）。
   - 保存校验整批原子生效：**报告不存在、两侧相同、配对重复（同一细胞出现多次）、
     细胞不存在**任一种情况都会被拒绝，**整次保存不生效**。
   - 修改比较记录必须携带**读取时版本号**；期间被他人改动（版本过期）时返回 HTTP 409
     与当前版本，页面自动加载最新版本，过期修改不写入。
   - 可导出与页面分区、数值完全一致的**比较 CSV**（UTF-8 BOM）。
   - 比较记录保存后即与草稿、后续发布解耦：**草稿后续改动或另发新报告都不改变已存比较**；
     比较记录创建时选定的两份报告不可更换。
10. **细胞迁移（三点对应仿射变换）**：在切片编辑页选择一份**已发布报告**作来源，
    在来源快照与当前草稿大图上按**相同顺序各标记 3 个不共线对应点**，
    把来源全部细胞的外轮廓与孔洞经仿射变换映射到当前草稿。
    - **预览先行**：服务端按同一变换映射全部细胞并**逐个套用与「保存轮廓」相同的几何校验**
      （越界/自交/孔洞不严格在外轮廓内/孔洞互触），页面在大图上以虚线叠加映射结果并列出
      每个细胞的校验结论；**任一细胞不合法即禁止提交**；
    - 对应点**重合、共线、坐标越界**（任一侧）都会被拒绝并指出具体原因；
      **来源无细胞、来源报告或目标草稿不存在**时明确报错；
    - **确认迁移必须携带预览时读取的目标草稿版本**；期间草稿被改动（版本过期）时
      拒绝写入（HTTP 409）并提示刷新，页面自动拉取最新草稿，需重新预览；
    - 成功后映射细胞**追加**到目标现有细胞之后：生成**不冲突的新标识**、**保留来源名称**、
      按**目标标尺**重算测量值，取样视野统计随细胞变动自动重算；
    - **来源报告、目标原有细胞与标尺、全部已发布报告均不改变**；
      预览与提交使用同一变换与校验，任何失败**整批不写入**。
11. **多视野合并统计（几何并集）**：在**切片编辑页**与**已发布报告页**，勾选
    **同一草稿/报告内至少两个**取样视野，即可查看所选视野的合并统计。
    - 面积按所选视野**净区域（外环扣除孔洞）的几何并集**精确计算（重叠区域只算一次），
      视野贴合处不留缝隙；
    - 归属规则：细胞以其**扣除孔洞后的净区域质心**判定，质心**严格位于并集内部**才计入——
      两个视野的贴合接缝属于并集内部（计入），并集**外边界不计入**，全部视野共有的孔洞
      不属于并集（不计入）；一个视野孔洞内但被另一视野覆盖的点仍属于并集；
    - **同一细胞只计一次**（即使它落在多个视野重叠区域）；净面积为零的细胞没有良定义质心，不计入；
    - 展示**并集面积（mm²）、细胞数、每 mm² 细胞密度、计入细胞的净面积总和（mm²）**；
      **未定标**时保留细胞数，面积/密度/总和显示**「待定标」**；
    - 草稿侧为**只读实时计算**：细胞轮廓、视野或标尺改变后按当前数据重算；
      报告侧**只读取发布时冻结数据**，草稿后续改动不影响结果；
    - **选择不足两个视野、视野标识重复、视野标识不存在**都会被明确拒绝（HTTP 400）；
      合并统计**不写库、不改变**任何原有逐视野统计与报告内容。

## 配置项

本轮（多视野合并统计）**未引入新的环境变量、外部依赖或数据库表结构变更**（合并统计为
只读实时计算，不写库），沿用既有配置；旧数据库无需任何迁移即可直接使用。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器/服务监听端口 |
| `DATA_DIR` | `./data`（Docker 中为 `/app/data`） | SQLite、原始图片、快照的保存目录（比较记录同在 `app.db` 内） |
| `HOST_PORT` | `8080` | 仅 Compose 使用：宿主机映射端口 |

## 一条命令启动（Docker Compose）

```bash
docker compose up -d --build
```

启动后浏览器访问：

```
http://localhost:8080
```

若 8080 端口被占用：

```bash
HOST_PORT=8088 docker compose up -d --build
# 然后访问 http://localhost:8088
```

数据持久化在 Docker 命名卷 `phytomeasure-data` 中。
若希望直接在宿主机目录查看数据，可把 `docker-compose.yml` 中的卷改为绑定挂载：

```yaml
volumes:
  - ./data:/app/data
```

停止与查看日志：

```bash
docker compose down
docker compose logs -f
```

## 非 Docker 方式运行（需 Node.js ≥ 20）

```bash
npm install
npm start
# 访问 http://localhost:8080
```

## 使用步骤（网页操作）

1. 首页上传图片，自动进入编辑器；
2. 选择 **📏 定标点工具**，在图上单击两个点，在弹窗中输入实际距离（μm）；
3. 选择 **⭕ 画细胞外轮廓**：单击逐个加点，双击（或回车）闭合；
4. 在细胞列表中选中某个细胞，用 **🕓 为选中细胞画孔洞** 工具绘制其孔洞；
5. 点击 **保存全部轮廓**——若有非法轮廓/孔洞，顶部红条会指出具体对象，本次保存整体不生效；
6. 右侧测量表实时显示净面积与总周长，滚轮缩放、拖拽平移不影响数值；
7. 在 **③ 取样视野（细胞密度）** 面板选择 **🔲 画取样视野**，像画细胞一样圈出外环并
   **双击/回车**完成；在视野列表选中视野后可用 **🕓 为选中视野画孔洞**；可随时改名/删除；
8. 点击 **保存全部视野**——越界、自交、孔洞不严格位于外环内或互相接触重叠、净面积非正
   都会被拒绝并指出具体视野，整批不生效；保存后（及细胞轮廓变动/重定标后）
   **⑤ 视野细胞密度统计** 自动给出各视野净面积 mm²、细胞数、每 mm² 细胞密度与计入净面积总和；
   未定标时面积/密度显示「待定标」，细胞数仍可查看；
9. 点击 **发布当前草稿为报告**，在「已发布报告」中查看冻结快照，
   报告页展示与「视野统计 CSV」完全一致的冻结视野统计，并可导出 PNG / 测量 CSV / 视野统计 CSV；
10. 需要合并多个视野时，在编辑器 **⑥ 多视野合并统计**（或报告页「多视野合并统计」）面板
    **勾选至少两个视野**：立即给出所选视野净区域**几何并集**的净面积 mm²、细胞数、
    每 mm² 密度与计入细胞净面积总和；重叠处细胞只计一次，贴合接缝计入、并集外边界不计入；
    草稿侧随轮廓/视野/标尺实时重算，报告侧只显示发布时冻结结果；勾选不足两个或标识异常会明确拒绝；
11. 需要对比两份报告时，进入 **报告比较**（流程不变，比较仍只读取冻结的细胞测量值）；
12. 需要把已发布报告的细胞搬到另一张切片时，在目标切片的编辑页打开 **⑦ 细胞迁移**：
    - 在下拉框选择**来源报告**（已发布），左侧出现来源快照；
    - 在来源快照上**依次单击 3 个对应点**（编号 1–3，自动连线提示顺序）；
    - 点 **🎯 标目标点工具**，在右侧大图上按**相同顺序**单击 3 个对应点
      （点错可「清除全部对应点」重标）；
    - 点 **预览迁移**：大图上以青色虚线叠加全部映射细胞（不合法细胞为红色），
      面板逐个列出校验结论；**任一细胞不合法或对应点重合/共线/越界都无法提交**；
    - 预览全部通过后点 **确认迁移**（携带预览时读取的草稿版本；若期间草稿被改动，
      会提示版本过期并自动刷新，需重新预览）；成功后映射细胞追加到细胞列表末尾，
      测量表与视野统计立即按当前标尺重算，可照常继续编辑、保存或发布。

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server/
│   ├── index.js       # Express API：上传/定标/轮廓/视野/发布/导出/报告比较/细胞迁移
│   ├── db.js          # SQLite 表结构与初始化（启动自动建表 + 旧库幂等补 fields 列）
│   ├── geometry.js    # 几何校验、面积/周长、净区域质心（服务端最终校验）
│   ├── fields.js      # 取样视野：质心归属、mm²/密度统计、未定标“待定标”
│   ├── merge-stats.js # 多视野几何并集（平面排列精确面积）+ 严格并集内部判定 + 合并统计（服务端/页端共用 UMD）
│   ├── compare.js     # 报告比较：手动一对一配对校验、冻结值差值/变化率视图
│   ├── transfer.js    # 细胞迁移：三点对应点校验、仿射求解、整批映射+逐细胞校验
│   ├── render.js      # sharp + SVG 渲染标注 PNG
│   └── exporter.js    # CSV（测量/汇总/视野统计/比较）与 ZIP 导出
├── public/            # 前端（原生 JS，无需构建）
├── test-geometry.js   # 几何自测（npm test）
├── test-fields.js     # 视野密度统计自测（npm test）
├── test-merge.js      # 多视野合并统计自测（npm test）
├── test-compare.js    # 报告比较自测（npm test）
├── test-transfer.js   # 细胞迁移自测（npm test）
└── data/              # 运行后生成：app.db、images/、snapshots/
```

## HTTP 接口与调用示例（取样视野 / 细胞密度）

视野与细胞轮廓一样属于**草稿**，随 `GET /api/images/:id` 一起返回；几何点一律为
图片原始像素坐标 `{x, y}`，环为点数组（首尾不需要重复），孔洞为环数组。
视野保存是**整批替换**并携带草稿 `version` 做乐观并发控制。

`GET /api/images/:id` 在 `fields` 之外还返回实时计算的 `fieldStats`（数组，按保存顺序）：

```json
{
  "id": "7ca3…", "version": 4,
  "fields": [
    { "id": "f1", "name": "视野1",
      "outer": [{"x":0,"y":0},{"x":100,"y":0},{"x":100,"y":100},{"x":0,"y":100}],
      "holes": [] }
  ],
  "fieldStats": [{
    "id": "f1", "name": "视野1", "holes": 0,
    "cellCount": 1,
    "countedCellKeys": ["cellA"],
    "areaMm2": 0.01, "densityPerMm2": 100, "countedCellAreaMm2": 0.0016,
    "areaText": "0.01", "densityText": "100", "countedCellAreaText": "0.0016",
    "calibrated": true
  }]
}
```

未定标时数值字段为 `null`，三个展示文本统一为 **`"待定标"`**，`cellCount` 照常给出；
`countedCellKeys` 为该视野计入细胞的标识（细胞 `id`，历史无 id 时为 `#序号`）。

### 保存视野（整批替换）

`PUT /api/images/:id/fields`，请求体：

```json
{
  "version": 3,
  "fields": [
    { "id": "f1", "name": "视野1",
      "outer": [{"x":0,"y":0},{"x":100,"y":0},{"x":100,"y":100},{"x":0,"y":100}],
      "holes": [] },
    { "id": "f2", "name": "视野2",
      "outer": [{"x":0,"y":0},{"x":200,"y":0},{"x":200,"y":200},{"x":0,"y":200}],
      "holes": [ [{"x":20,"y":20},{"x":40,"y":20},{"x":40,"y":40},{"x":20,"y":40}] ] }
  ]
}
```

- 成功返回**更新后的整份草稿**（`version + 1`、含新 `fieldStats`）；
- 视野越界 / 自交 / 孔洞不严格位于外环内 / 孔洞彼此接触或重叠 / 净面积非正
  → **HTTP 400**，错误信息指出具体视野，**整批不写入、版本不变**；
- 携带的 `version` 过期 → **HTTP 409** `{error, currentVersion}`，按草稿冲突处理，整次不写入；
- 视野与轮廓共用同一草稿版本：先存轮廓会让旧 `version` 失效，重新 `GET` 后再存视野即可。

curl 示例：

```bash
# 1) 取版本号
curl -s http://localhost:8080/api/images/$IMG_ID | jq .version

# 2) 保存两个视野（一个带孔洞）
curl -s -X PUT http://localhost:8080/api/images/$IMG_ID/fields \
  -H 'Content-Type: application/json' \
  -d @fields.json

# 3) 发布（冻结视野与统计；同样要带读取时版本号）
curl -s -X POST http://localhost:8080/api/images/$IMG_ID/publish \
  -H 'Content-Type: application/json' \
  -d '{"version":4,"title":"切片A 报告"}'
```

Node.js 示例（无第三方依赖）：

```js
const base = 'http://localhost:8080';

async function saveFields(imageId, fields) {
  const img = await fetch(`${base}/api/images/${imageId}`).then((r) => r.json());
  const res = await fetch(`${base}/api/images/${imageId}/fields`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: img.version, fields })
  });
  if (res.status === 409) {
    const { currentVersion } = await res.json();
    throw new Error(`草稿冲突，请用最新版本 v${currentVersion} 重试`);
  }
  if (!res.ok) throw new Error((await res.json()).error); // 400：整批被拒
  const saved = await res.json();
  for (const s of saved.fieldStats) {
    console.log(`${s.name}: 净面积 ${s.areaText} mm², 细胞 ${s.cellCount}, ` +
                `密度 ${s.densityText} 个/mm², 计入净面积总和 ${s.countedCellAreaText} mm²`);
  }
}

saveFields(process.env.IMG_ID, [
  { name: '中心视野',
    outer: [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}],
    holes: [] }
]);
```

### 冻结结果（报告页与视野统计 CSV 完全一致）

`GET /api/reports/:id` 返回发布时冻结的 `fields` 与 `fieldStats`；
旧报告缺少视野时二者都是空列表。单独导出：

```bash
curl -s -OJ http://localhost:8080/api/reports/$REPORT_ID/field-csv
# -> <report_id>_fields.csv（UTF-8 BOM）
# 列：视野名称,孔洞数,净面积(mm²),细胞数,细胞密度(个/mm²),计入细胞净面积总和(mm²)
# 未定标/旧报告对应列为“待定标”或“（无取样视野）”
```

原 `GET /api/reports/:id/csv`（测量 CSV，μm²）、`/png`、批量导出与报告比较结果
**保持原义不变**；视野统计是独立 CSV，不混入测量 CSV。

## 多视野合并统计 HTTP 接口（几何并集，只读）

在**同一草稿**或**同一报告**内选择**至少两个**取样视野，按所选视野净区域
（外环扣除孔洞）的**几何并集**返回合并统计。两个接口都是**只读**的，不写库、
不改变任何逐视野统计与报告内容；请求体均为 `{ "fieldIds": string[] }`，
标识为 `GET /api/images/:id` / `GET /api/reports/:id` 返回的视野 `id`。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/images/:id/field-merge` | 草稿合并统计：按**当前**细胞轮廓、视野与标尺实时计算；草稿不存在 → 404 |
| `POST /api/reports/:id/field-merge` | 报告合并统计：只读取**发布时冻结**的 fields/cells/calib；报告不存在 → 404 |

错误语义（两个接口一致）：

- `fieldIds` 不是数组 / 含非字符串 → **400**；
- 选择**不足 2 个**视野 → **400**（指明当前个数）；
- 视野标识**重复** → **400**（指明重复的 id）；
- 视野标识在该草稿/报告内**不存在**（草稿视野被删除/改动后旧 id 失效）→ **400**（指明不存在的 id）。

成功响应示例（草稿；报告侧 `scope:"report"` 且返回 `draftVersion`）：

```json
{
  "scope": "draft",
  "imageId": "7ca3…",
  "version": 4,
  "calibrated": true,
  "stats": {
    "kind": "field-merge",
    "fieldCount": 2,
    "fieldIds": ["f1", "f2"],
    "fieldNames": ["视野1", "视野2"],
    "areaPx": 10000,
    "areaMm2": 0.01,
    "cellCount": 3,
    "countedCellKeys": ["cellA", "cellB", "#2"],
    "countedCells": [
      { "key": "cellA", "name": "Alpha" },
      { "key": "cellB", "name": "Beta" }
    ],
    "countedCellAreaPx": 320,
    "countedCellAreaMm2": 0.0032,
    "densityPerMm2": 300,
    "areaText": "0.01",
    "densityText": "300",
    "countedCellAreaText": "0.0032",
    "calibrated": true
  }
}
```

- 并集面积按平面排列（半边缘遍历）精确计算：重叠/共线/旋转多边形均为真实几何并集，
  非面积简单加减；`areaText` 保留 6 位小数、`densityText` 4 位，与逐视野统计同一规则；
- **未定标**（草稿未完成标尺定标）时 `areaMm2`/`densityPerMm2`/`countedCellAreaMm2` 为
  `null`，三个展示文本统一为 **`"待定标"`**，`cellCount` 与 `countedCellKeys` 照常给出；
- 细胞以净区域质心**严格位于并集内部**才计入，`countedCellKeys` 为计入细胞标识
  （细胞 `id`，历史无 id 时为 `#序号`），同一细胞在并集中只出现一次。

curl 示例（草稿 `IMG`；报告把 `/api/images/$IMG/field-merge` 换成
`/api/reports/$RID/field-merge`）：

```bash
# 合并两个贴合视野（并集 = 两视野净区域几何并集）
curl -s -X POST http://localhost:8080/api/images/$IMG/field-merge \
  -H 'Content-Type: application/json' \
  -d '{"fieldIds":["f1","f2"]}' | jq '.stats |
    {fieldNames, areaMm2, cellCount, densityPerMm2, countedCellAreaMm2, countedCellKeys}'

# 不足两个 / 重复 / 不存在 → 400
curl -s -X POST http://localhost:8080/api/images/$IMG/field-merge \
  -H 'Content-Type: application/json' -d '{"fieldIds":["f1"]}'
# -> { "error": "合并统计至少需要选择 2 个同一草稿/报告内的取样视野（当前选择 1 个），请求被拒绝" }
```

Node.js 示例（无第三方依赖；草稿改动后按最新数据重算，报告始终冻结）：

```js
const base = 'http://localhost:8080';

async function mergeFields(pathKind, id, fieldIds) {
  const res = await fetch(`${base}/api/${pathKind}/${id}/field-merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fieldIds })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error || `HTTP ${res.status}`);
    e.status = res.status;
    throw e; // 400：不足两个/重复/不存在；404：草稿或报告不存在
  }
  const s = body.stats;
  console.log(`合并 ${s.fieldCount} 个视野（${s.fieldNames.join('、')}）`);
  console.log(`并集净面积 ${s.areaText} mm² · 细胞 ${s.cellCount} · ` +
              `密度 ${s.densityText} 个/mm² · 计入净面积总和 ${s.countedCellAreaText} mm²`);
  return body;
}

// 草稿：随轮廓/视野/标尺改变按当前数据重算
await mergeFields('images', process.env.IMG, ['f1', 'f2']);
// 报告：只读取发布时冻结数据
await mergeFields('reports', process.env.RID, ['f1', 'f2']);
```

## 细胞迁移 HTTP 接口（三点对应仿射变换）

把一份**已发布报告**的全部细胞映射到**另一张图片草稿**。
`sourcePoints` / `targetPoints` 各为按相同顺序给出的 **3 个不共线对应点**
（图片原始像素坐标 `{x, y}`；服务端按 3 位小数取整后求解，预览与提交因此是同一变换）。
预览与确认提交共用同一套映射与几何校验；任何失败**整批不写入**。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/images/:id/migrate/preview` | 预览：`{reportId, sourcePoints, targetPoints}` → 仿射系数、逐细胞映射轮廓与校验结论、按目标标尺预算的测量值、预览时读取的目标草稿版本；不写入任何数据 |
| `POST /api/images/:id/migrate` | 确认迁移：`{version, reportId, sourcePoints, targetPoints}`，`version` 必须为**预览时读取的目标草稿版本**；全部校验通过才把映射细胞追加到目标（新标识、保留名称、按目标标尺重算测量），返回更新后的整份草稿 |

错误语义：

- 目标草稿不存在 → **404**；来源报告不存在 → **404**；缺少 `reportId` → **400**；
- 来源报告无细胞 → **400**（指明报告标题）；
- 对应点数量不足/坐标非法/**重合/共线/越界**（任一侧）→ **400**，指明侧别与具体点；
- 映射后任一细胞不满足几何规则 → 预览 `ok:false` 并逐细胞给出原因；
  提交时同样拒绝（**400**，**整批不写入**，目标版本不变）；
- 携带的 `version` 过期 → **409** `{error, currentVersion}`，提示刷新后重新预览；
- 成功（**201**）：目标 `version + 1`，映射细胞追加到现有细胞之后，
  目标原有细胞/标尺/视野、来源报告与全部已发布报告均不改变。

预览响应示例（节选）：

```json
{
  "target": { "id": "img-B", "version": 4, "width": 400, "height": 300 },
  "source": { "reportId": "rep-A", "title": "切片A报告", "cellCount": 2 },
  "transform": { "a": 1.5, "b": 0, "c": 50, "d": 0, "e": 1.5, "f": 50 },
  "ok": true, "okCount": 2, "failCount": 0,
  "cells": [
    { "key": "cell-a", "name": "Alpha", "seq": 1, "ok": true, "error": null,
      "outer": [{"x":65,"y":65},{"x":140,"y":65},{"x":140,"y":125},{"x":65,"y":125}],
      "holes": [[{"x":80,"y":80},{"x":95,"y":80},{"x":95,"y":95},{"x":80,"y":95}]],
      "areaUm2": 267.1875, "perimeterUm": 82.5 }
  ]
}
```

curl 示例（目标草稿 `IMG`、来源报告 `RID`）：

```bash
# 1) 预览：来源三点 (0,0)(100,0)(0,100) ↔ 目标三点 (50,50)(200,50)(50,200)
curl -s -X POST http://localhost:8080/api/images/$IMG/migrate/preview \
  -H 'Content-Type: application/json' \
  -d "{\"reportId\":\"$RID\",
       \"sourcePoints\":[{\"x\":0,\"y\":0},{\"x\":100,\"y\":0},{\"x\":0,\"y\":100}],
       \"targetPoints\":[{\"x\":50,\"y\":50},{\"x\":200,\"y\":50},{\"x\":50,\"y\":200}]}" \
  | jq '{ok, failCount, targetVersion: .target.version,
         cells: [.cells[] | {name, ok, error}]}'

# 2) 确认迁移：version 必须取上一步预览返回的 target.version
curl -s -X POST http://localhost:8080/api/images/$IMG/migrate \
  -H 'Content-Type: application/json' \
  -d "{\"version\":4,\"reportId\":\"$RID\",
       \"sourcePoints\":[{\"x\":0,\"y\":0},{\"x\":100,\"y\":0},{\"x\":0,\"y\":100}],
       \"targetPoints\":[{\"x\":50,\"y\":50},{\"x\":200,\"y\":50},{\"x\":50,\"y\":200}]}" \
  | jq '{appendedCount, newVersion: .image.version,
         cells: [.image.cells[] | {id, name, areaUm2}]}'
```

Node.js 示例（无第三方依赖；含 409 刷新重试）：

```js
const base = 'http://localhost:8080';

async function migrateCells(targetImageId, reportId, sourcePoints, targetPoints) {
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async (r) => {
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(b.error || `HTTP ${r.status}`); e.status = r.status; e.body = b; throw e; }
    return b;
  });

  // 预览：同一变换与校验，不写入
  const preview = await post(`/api/images/${targetImageId}/migrate/preview`,
    { reportId, sourcePoints, targetPoints });
  if (!preview.ok) {
    const bad = preview.cells.filter((c) => !c.ok).map((c) => `${c.label}：${c.error}`);
    throw new Error(`预览未通过，禁止提交：\n${bad.join('\n')}`);
  }

  try {
    // 确认：携带预览时读取的目标草稿版本
    return await post(`/api/images/${targetImageId}/migrate`,
      { version: preview.target.version, reportId, sourcePoints, targetPoints });
  } catch (e) {
    if (e.status === 409) {
      throw new Error(`目标草稿已过期（当前 v${e.body.currentVersion}），请刷新后重新预览再迁移`);
    }
    throw e; // 400：对应点非法 / 来源无细胞 / 映射后轮廓不合法，整批未写入
  }
}

const result = await migrateCells(
  process.env.IMG, process.env.RID,
  [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
  [{ x: 50, y: 50 }, { x: 200, y: 50 }, { x: 50, y: 200 }]
);
console.log(`已迁移 ${result.appendedCount} 个细胞，目标草稿版本 v${result.image.version}`);
for (const s of result.image.fieldStats) {
  console.log(`${s.name}: 细胞 ${s.cellCount}，密度 ${s.densityText} 个/mm²`);
}
```

## 报告比较 HTTP 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/comparisons` | 比较记录列表（标题、两侧报告、配对数、版本、时间） |
| `POST /api/comparisons` | 新建：`{baselineReportId, retestReportId, title?, pairs:[{baselineCellKey, retestCellKey}]}`；报告不存在/两侧相同/配对重复/细胞不存在 → 400，整次不生效 |
| `GET /api/comparisons/:id` | 比较结果：两侧冻结定标、逐对细胞两侧数值/带符号差值/变化率（基线 0 为 `不可计算`）、两侧未配对细胞 |
| `PUT /api/comparisons/:id` | 修改标题与配对（两侧报告不可更换），须携带读取时 `version`；过期 → 409 并返回 `currentVersion`，整次修改不写入 |
| `GET /api/comparisons/:id/csv` | 导出与页面一致的比较 CSV（UTF-8 BOM） |

## 全部 HTTP 接口一览（既有 + 本轮）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/images` / `POST /api/images` | 草稿列表 / 上传图片（multipart 字段 `image`） |
| `GET /api/images/:id` | 草稿详情（含 `cells`、`fields`、实时 `fieldStats`） |
| `GET /api/images/:id/file` | 原始图片 |
| `PUT /api/images/:id/calibration` | 定标/重定标（带 `version`，过期 409）；视野统计随新比例重算 |
| `PUT /api/images/:id/contours` | 整批保存细胞轮廓（带 `version`；非法 400 整批不生效；过期 409） |
| **`PUT /api/images/:id/fields`** | **整批保存取样视野（带 `version`；非法 400 整批不生效；过期 409）** |
| **`POST /api/images/:id/field-merge`** | **多视野合并统计（只读，按草稿当前数据实时计算；不足两个/重复/不存在 400）** |
| `POST /api/images/:id/publish` | 发布冻结（含视野与统计；带 `version`，过期 409） |
| **`POST /api/images/:id/migrate/preview`** | **迁移预览：三点对应仿射映射 + 逐细胞校验（不写入；返回预览时目标草稿版本）** |
| **`POST /api/images/:id/migrate`** | **确认迁移（带预览时版本，过期 409；任一校验失败 400 整批不写入）** |
| `GET /api/reports` / `GET /api/reports/:id` | 报告列表 / 冻结详情（旧报告 `fields` 为空列表） |
| **`POST /api/reports/:id/field-merge`** | **报告内多视野合并统计（只读，只取发布时冻结数据；不足两个/重复/不存在 400）** |
| `GET /api/reports/:id/file` / `/png` | 发布时图片快照 / 标注 PNG |
| `GET /api/reports/:id/csv` | 测量 CSV（μm²，原义不变） |
| **`GET /api/reports/:id/field-csv`** | **视野统计 CSV（mm²，与报告页同一冻结结果）** |
| `POST /api/reports/export` | 批量导出 `{ids, format:'csv'\|'png'\|'zip'}` |
| `GET/POST /api/comparisons`、`GET/PUT /api/comparisons/:id`、`GET /api/comparisons/:id/csv` | 报告比较（见上表） |
