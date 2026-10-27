import { Plugin } from "@opencode/plugin"
import { buildReport, formatReport } from "./quota"

async function usageText(ctx: any): Promise<string> {
  return formatReport(await buildReport(ctx))
}

export default Plugin.define({
  id: "codex-usage",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "codex_usage",
        description:
          "Read local Codex/OpenAI 5-hour and weekly rate-limit usage. This is read-only and does not switch accounts.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          return { content: await usageText(ctx) }
        },
      })
    })
  },
})
