# Anthropic integration notes

Verified against Anthropic's official documentation on 2026-11-15.

- The task-text generator uses the fixed model ID `claude-haiku-5-5` with temperature 0.
- The TypeScript SDK call is `client.messages.create(...)`. The integration disables SDK retries and applies its own bounded exponential backoff so retry behavior is explicit and testable.
- Requests time out after 60 seconds. Retryable conditions are connection failures plus HTTP 408, 409, 429, and 5xx responses.
- Actual `input_tokens` and `output_tokens` from each response are stored and totaled. The printed cost is an estimate using the documented base Haiku 5.5 rates of $0.10/MTok input and $0.50/MTok output; cache and service-tier pricing can differ.
- API responses are cached in the `llm` `DiskCache` namespace by commit SHA and prompt version. A prompt change must increment `TASK_TEXT_PROMPT_VERSION`.

Sources:

- [Models overview](https://platform.claude.com/docs/en/models/overview)
- [TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript)
- [Create a Message](https://platform.claude.com/docs/en/api/typescript/messages/create)
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing?v=20261011)
