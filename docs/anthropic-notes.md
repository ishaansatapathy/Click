# Task-text provider notes

Verified against the providers' official documentation on 2026-11-15.

- `TASK_TEXT_PROVIDER` selects `openai` or `anthropic`. OpenAI is the default when `OPENAI_API_KEY` exists.
- The OpenAI default is `gpt-6-luna` through the Responses API. It uses `reasoning.effort: "none"`, which permits `temperature: 0`, and caps output with `max_output_tokens`.
- The OpenAI SDK returns text through `output_text` and usage through `input_tokens` / `output_tokens`.

- The task-text generator uses the fixed model ID `claude-haiku-5-5` with temperature 0.
- The TypeScript SDK call is `client.messages.create(...)`. The integration disables SDK retries and applies its own bounded exponential backoff so retry behavior is explicit and testable.
- Requests time out after 60 seconds. Retryable conditions are connection failures plus HTTP 408, 409, 429, and 5xx responses.
- Actual `input_tokens` and `output_tokens` from each response are stored and totaled. The printed cost is an estimate using the documented base Haiku 5.5 rates of $0.10/MTok input and $0.50/MTok output; cache and service-tier pricing can differ.
- API responses are cached in the `llm` `DiskCache` namespace by provider, model, prompt version, and commit SHA. A prompt change must increment `TASK_TEXT_PROMPT_VERSION`.

Sources:

- [GPT-6 Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model)
- [Responses create API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)

- [Models overview](https://platform.claude.com/docs/en/models/overview)
- [TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript)
- [Create a Message](https://platform.claude.com/docs/en/api/typescript/messages/create)
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing?v=20261011)
