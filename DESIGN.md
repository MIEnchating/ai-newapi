# Design

## Product

RelayDesk 管理后台，产品型界面，面向高频运维与渠道管理。

## Theme

默认支持亮色和暗色。使用场景是管理员在桌面环境中持续巡检渠道状态，白天偏亮色，夜间或低光环境偏暗色，因此主题切换是明确功能而不是装饰。

## Color

策略：Restrained。以冷调中性色为主，蓝色只用于主操作、当前选中、链接和信息状态。成功、警告、错误分别使用绿色、琥珀色、红色，并配合文字说明。

Current tokens:

- Primary: `--vben-primary`
- Hover primary: `--vben-primary-hover`
- App background: `--vben-app-bg`
- Sidebar: `--vben-sider`
- Header: `--vben-header`
- Card: `--vben-card`
- Soft card: `--vben-card-soft`
- Border: `--vben-border`
- Soft border: `--vben-border-soft`
- Text: `--vben-text`
- Muted text: `--vben-text-muted`

## Typography

使用系统无衬线字体。后台标题保持紧凑，不使用流体大字号。正文和表格优先可读性，说明文案控制在 65 到 75 个字符以内。

## Layout

桌面端为侧边导航、顶部工具栏、页签栏和内容区。内容区使用表格、分组折叠面板、表单和状态摘要。卡片只用于指标、表格容器、弹窗和明确的重复项，不做套娃卡片。

## Components

- Tables: 高密度扫描，固定操作列，缺失值显示 `未获取` 或 `-`。
- Modals: 仅用于短流程配置，凭证弹窗和渠道弹窗职责分离。
- Switches: 需要明显的开关状态，必须有文字或上下文标签。
- Status tags: 状态色必须配合文本，不只依赖颜色。
- Forms: 垂直布局，补充说明放在 `extra` 或辅助文案里。

## Motion

只做状态反馈和轻量过渡，时长 150 到 250ms。禁止布局属性动画，尊重 `prefers-reduced-motion`。

## Quality Bar

以可上线的管理后台为标准。优先修复交互混淆、职责混杂、可访问性、移动端溢出、暗色主题和视觉反模式。
