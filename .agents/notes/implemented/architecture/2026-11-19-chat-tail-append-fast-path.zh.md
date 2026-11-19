# Agent Note: Chat snapshot tail-append fast path

Status: implemented

[English](2026-11-19-chat-tail-append-fast-path.md) | 中文

## Problem

单 Turn 内累积大量 Step 时,Chat snapshot builder 的每步成本与已加载节点数成正比:每次含新节点的 flush 都会在 `turnProcessPresentations` 下重新过滤并重排整个可见集、重建整个位置索引、重建整个 Turn 侧栏。0.2.2 的 assembler 热补丁消除了 `ui-conversation` 中 Context 重放的二次项, builder 的全量通道随之成为剩余的主要成本;1600 步单 Turn probe 在开发机上投影耗时约 5.2–6.3 秒,且每步成本仍在线性增长。

## Decision

`ChatSnapshotBuilder.apply` 对每个 upsert 批次做分类,并在可证明安全时走验证过的尾部追加路径:所有结构性变更都是全新节点、没有 `turn-process` upsert 越过缓存的 control 身份、且每个追加的可见节点都可证明排在呈现尾部之后。验证读取一张按 Turn 维护的状态表(`controlKey`、`controlAnchorSeq`、`openingInputAnchor`),由完整呈现通道播种、由追加在原地推进;opening-input 锚点可以增量推进,因为追加的锚点只会增大。安装阶段把追加块推入 order、扩展 `MutableChatLocationIndex` 的位置与 Turn/Step 列表,并把追加节点并入 `MutableTurnNavigationIndex` 的侧栏项;仅当某 Turn 获得首个侧栏项或首个用户输入时才整项重推导。

验证无法证明的情况一律回退到完整呈现通道,并由该通道重新播种状态:已有节点的结构性变更(kind、anchor、visibility、group、location)、control 物化或变更其 opening 锚点、control 位于尾部、以及排在尾部之前的追加节点(含被拉近的 rank-2 节点)。`earliestProcessAnchor` 被有意排除在状态之外:它只参与 control 的 rank -1 摆放,且在 visibility 翻转下不具单调性,跟踪它会让验证失真。

## Alternatives considered

**对完整通道做常数级优化。** 预计算排序键能缩小每步常数,但总量仍是二次增长;在 1600 步时尾部每步成本沿同样的增长曲线爬升。

**把 process 呈现完全增量化的,包括 `earliestProcessAnchor`。** control 的 rank -1 摆放依赖最早的过程候选,而 visibility 翻转可能让它变小;增量维护它需要在每次 visibility 变化时失效。把它排除在 fast-path 状态之外,让罕见的完整通道保持唯一事实来源。

**用持久化结构避免每次 flush 复制 order 数组。** 这次复制是线性且 memcpy 量级的常数,与被移除的 O(N log N) 比较器排序相比可以忽略;rope 或持久化列表带来的读者侧复杂度换不来可测的收益。

## Consequences

活跃追加的 flush 成本为 O(追加量) 加一次 order 数组复制;同一开发机上 1600 步 probe 从 5.18 秒降到约 3.7–4.0 秒(mounted),从 6.28 秒降到约 3.4–3.5 秒(bare),行为测试与录制会话快照结果不变。每步成本仍随已加载节点数增长,经由本决策不拥有的通道:`derivePresentation` 全 Turn 扫描以及 Turn spec 对象变化时全部按 key process source 的重发布、legacy 切片对全部 finalized 贡献的重排序、`locations.touch` 的 Turn 成员扫描,以及 `ui-conversation` 位置索引每条边界对边界所属 seq 的扫描。浏览器侧行虚拟化是独立决策,需要独立的浏览器证据。
