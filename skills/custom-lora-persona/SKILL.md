---
name: custom-lora-persona
description: >-
  帮用户给 MiniCPM-Desk-Pet 桌宠做一个自定义人格 / 皮肤：微调一个 LoRA、转成 GGUF、
  在 App 里上传并切换。覆盖"训练 → 转 GGUF → 上传 → 启用"的完整链路。
  Use when the user wants a custom desktop-pet persona, asks
  "做一个自己的桌宠人格 / 角色", "训练 / 上传自定义 LoRA", "把我的 LoRA 用到桌宠上",
  "convert LoRA to GGUF for the pet", or hits errors uploading a .gguf adapter in Settings.
---

# 给桌宠做一个自定义 LoRA 人格

MiniCPM-Desk-Pet 支持上传你自己的 **LoRA 适配器**，给桌宠换一套说话风格 / 人格（内置的「猫娘」就是这么来的）。这条 Skill 把整个链路串起来：

```
  微调 LoRA            转成 GGUF              在 App 里
 (任一框架)   ──►   (llama.cpp 转换)   ──►   上传 + 启用
 PEFT adapter        adapter.gguf            Settings → MiniCPM
```

> **关键认知**：App 的后端是 `llama-server`，它只认 **GGUF 格式的 LoRA 适配器**（通过 `--lora` 加载）。
> 大多数微调框架产出的是 PEFT 格式（`adapter_model.safetensors`），**不能直接上传**——中间必须做一次
> `safetensors → GGUF` 的转换。这是最容易卡住的地方。

## 前提：必须针对 MiniCPM5-1B 训练

桌宠跑的就是 MiniCPM5-1B（GGUF）。你的 LoRA **必须基于同一个 base 模型**训练，否则适配器套上去等于乱码。

- base 模型：`openbmb/MiniCPM5-1B`（fp16 HF 版，用于训练）。
- 训练数据：messages 格式 JSONL，例如
  `[{"messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}]`。

## 完整步骤

### 1. 训练一个 LoRA（在 OpenBMB/MiniCPM 仓库里做）

训练相关的 Skill 都在上游 [`OpenBMB/MiniCPM`](https://github.com/OpenBMB/MiniCPM) 仓库的 `skills/` 下，**不在本仓库**。按硬件挑一个：

| 你的情况 | 用哪个 Skill |
| --- | --- |
| 第一次微调，想最省心 | `minicpm5-finetune-llamafactory` |
| 单张消费级显卡 / 显存吃紧（≤24GB） | `minicpm5-finetune-unsloth`（`load_in_4bit=True` 走 QLoRA） |
| 还没想好 / 想看全部选项 | `minicpm5-finetune`（路由总览） |

产物是一个目录，里面有 `adapter_config.json` + `adapter_model.safetensors`。

### 2. 转成 GGUF 适配器（这一步桌宠才认）

同样在上游仓库，有专门的 Skill：**`minicpm5-finetune-gguf-lora`**。核心命令：

```bash
# 在 llama.cpp 仓库目录下
python convert_lora_to_gguf.py /path/to/你的adapter目录 \
    --base openbmb/MiniCPM5-1B \
    --outtype f16 \
    --outfile ~/my-pet-persona.gguf
```

> 🔑 **最大的坑**：`adapter_config.json` 里记录的 `base_model_name_or_path` 往往是**训练那台机器的绝对路径**，
> 换到你的机器上找不到。所以**一定要显式传 `--base openbmb/MiniCPM5-1B`**（或 `--base-model-id openbmb/MiniCPM5-1B`）
> 覆盖它。`--base` 只需要 base 模型的 config，不需要完整权重。

转出来的 `.gguf` 很小（r=16 的适配器大约几十 MB），这就是要上传的文件。

> 本仓库 `adapters/` 下那个内置「猫娘」适配器，旁边的 `adapter_model.f16.gguf` 就是这么从
> `adapter_model.safetensors` 转出来的——可以照着对。

### 3. 在 App 里上传

1. 打开 **Settings → 🐾 MiniCPM**，找到「适配器 (LoRA)」区。
2. 点 **上传**，选你的 `.gguf` 文件。App 会把它复制进 `<userData>/adapters/uploads/` 并登记。
3. 填一个**显示名**和**别名**（逗号分隔）。别名用于语音 / 聊天切换，例如设了别名「小狐狸」，之后对桌宠说"换成小狐狸"就能切。
4. 在适配器列表里**选中**它即可启用——sidecar 会带上你的 `--lora` 重启 `llama-server`。

App 的校验（不满足会被拒）：

- **只接受单个 `.gguf` 文件**（第 2 步转出来的那个，不是 `.safetensors`，也不是合并后的整模型）。
- 适配器是叠在 App 自带的 MiniCPM5-1B GGUF base 上跑的，所以**必须针对 MiniCPM5-1B 训练**。

### 4. 验证

切到你的适配器后，对桌宠说几句，看人格 / 语气有没有变。

- **变了** → 成功。
- **跟原来一模一样** → 适配器没真正生效：多半是第 2 步 `--base` 没对上（base 不匹配），或者你上传错了文件。
- 想确认 GGUF 是不是合法的 LoRA：`python -c "import gguf; r=gguf.GGUFReader('~/my-pet-persona.gguf'); print(len(r.tensors),'tensors')"`，tensor 数应大于 0。

## 常见问题

### 上传时提示「必须是 .gguf 文件」
你选的是 `.safetensors`（PEFT 原始产物）。回到第 2 步先转成 GGUF。

### 上传成功但桌宠没反应 / 像没装一样
- LoRA 只做**风格偏置**，分量不够时效果不明显——可以加大训练数据 / epoch，或调高 `lora_alpha`。
- 内置人格（如猫娘）除了 LoRA 还配了**系统提示词**；自定义上传目前主要靠 LoRA 本身的风格。想要更强的人格感，训练数据里就把目标语气/口头禅喂足。

### 转换报 `can't load base model config` / `FileNotFoundError`
就是第 2 步那个坑：`adapter_config.json` 里的 base 路径在你机器上不存在。用 `--base openbmb/MiniCPM5-1B` 覆盖。

### 想删掉上传的适配器
在同一个适配器列表里删除即可（只能删自己上传的，内置预置删不掉）。如果删的正好是当前启用的，App 会先在 sidecar 侧卸载再删文件。

### 适配器去哪了 / 文件在哪
上传的文件在 `<userData>/adapters/uploads/`（dev 模式下是仓库的 `adapters/`）。sidecar 启动时扫描这个目录里的 `*.gguf`。

## 这条 Skill 不负责什么

- **怎么训练**（数据准备、超参、跑训练）→ 上游 `minicpm5-finetune*` 系列。
- **转换命令的全部细节** → 上游 `minicpm5-finetune-gguf-lora`。
- **从源码部署桌宠** → 本仓库的 `deploy-minicpm-pet`。

本 Skill 是把上面这些串成"给桌宠做人格"的一条用户视角主线。

## 参考

- 上游训练 / 转换 Skills：[`OpenBMB/MiniCPM`](https://github.com/OpenBMB/MiniCPM) 仓库 `skills/`（`minicpm5-finetune`、`minicpm5-finetune-gguf-lora`）。
- App 内入口：**Settings → 🐾 MiniCPM → 适配器 (LoRA)**。
- README 的 Persona Adapters 段落也有简述。
