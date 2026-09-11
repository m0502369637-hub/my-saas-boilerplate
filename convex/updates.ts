import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { JobRow } from "./queries";
import type { Id } from "./_generated/dataModel";
import type { Service } from "./lib/services/types";
import { getService, photoService, promptService, serviceCostsLine } from "./lib/services/registry";
import { renderStatusText, statusKeyboard, statusLabel, TERMINAL_STATUSES } from "./lib/format";
import * as telegram from "./lib/telegram";

// updates.ts — the bot's brain. One action per incoming Telegram update,
// reached from the /telegram webhook (and the local dev long-poller).
//
// Rules:
//   - Claim the update_id FIRST (processed_updates) — at-least-once delivery.
//   - Never await generation output here. The longest waits are the job
//     submit (a few fast HTTP calls) — completion is discovered later by the
//     scheduler chain, the fal webhook, the 🔄 button, or the cron sweep.
//   - All money moves through mutations (jobs.ts / users.ts) — never here.

// --- update entry -----------------------------------------------------------------

export const processUpdate = internalAction({
  args: { update: v.any() },
  handler: async (ctx, args): Promise<{ processed: boolean }> => {
    const update = args.update as Record<string, any>;
    const updateId = typeof update?.update_id === "number" ? update.update_id : NaN;
    if (!Number.isFinite(updateId)) return { processed: true }; // nothing claimable
    const claimed = await ctx.runMutation(internal.updates_mutations.claimUpdate, {
      updateId,
    });
    if (!claimed) return { processed: true }; // duplicate delivery

    try {
      if (update.message) await handleMessage(ctx, update.message);
      else if (update.callback_query) await handleCallbackQuery(ctx, update.callback_query);
      else if (update.pre_checkout_query) await handlePreCheckout(ctx, update.pre_checkout_query);
      // every other update type is ignored
      return { processed: true };
    } catch (e) {
      console.error("update handling failed", {
        updateId,
        reason: e instanceof Error ? e.message : String(e),
      });
      // Handled-and-claimed: return processed so Telegram does not retry
      // forever. Job/refund state is protected by its own mutations.
      return { processed: true };
    }
  },
});

// --- message routing --------------------------------------------------------------

type Ctx = {
  runMutation: Function;
  runQuery: Function;
  runAction: Function;
};

async function handleMessage(ctx: Ctx, message: Record<string, any>): Promise<void> {
  const chat = message?.chat;
  const from = message?.from;
  if (!chat || from?.is_bot) return;
  const chatId = chat.id as number;

  // A paid Stars invoice lands as a normal message with successful_payment.
  if (message.successful_payment) {
    const sp = message.successful_payment;
    if (sp?.currency === "XTR" && sp?.invoice_payload === "buy_stars") {
      const amount = Number(sp.total_amount) || 0;
      if (amount > 0) {
        await ctx.runMutation(internal.users.creditStars, {
          telegramId: from.id,
          amount,
          kind: "purchase",
          description: "Telegram Stars invoice",
        });
        await telegram.sendMessage(chatId, `✅ ${amount} ⭐ added to your balance. Send /help to see what I can do!`);
      }
    }
    return;
  }

  if (chat.type !== "private") return; // billed per user in private chats only

  await ctx.runMutation(internal.users.upsertUser, {
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    language: from.language_code,
  });

  // Photo → the photo-triggered service (largest size = last PhotoSize entry).
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const svc = photoService();
    if (!svc) return;
    const fileId = message.photo[message.photo.length - 1].file_id as string;
    await runJob(ctx, chatId, from.id, svc, { photoFileId: fileId });
    return;
  }

  const text = String(message.text ?? "").trim();
  if (!text.startsWith("/")) {
    await telegram.sendMessage(chatId, `Send /help to see what I can do.`);
    return;
  }
  const cmd = text.split(/[@\s]/, 1)[0];

  // Prompt-triggered service commands (e.g. /imagine <prompt>).
  const promptSvc = promptService();
  const promptCommand = promptSvc?.config.trigger.kind === "prompt" ? promptSvc.config.trigger.command : undefined;
  if (promptSvc && promptCommand && cmd === promptCommand) {
    const prompt = text.slice(promptCommand.length).trim();
    if (!prompt) {
      await telegram.sendMessage(chatId, `Usage: ${promptCommand} <your prompt>`);
      return;
    }
    await runJob(ctx, chatId, from.id, promptSvc, { prompt });
    return;
  }

  switch (cmd) {
    case "/start": {
      await registerCommandsOnce(ctx);
      await telegram.sendMessage(chatId, helpText(), {
        parseMode: "HTML",
        replyMarkup: buyKeyboard(),
      });
      return;
    }
    case "/balance": {
      const balance = await ctx.runQuery(internal.users.getBalance, { telegramId: from.id });
      await telegram.sendMessage(
        chatId,
        `💰 Balance: <b>${balance} ⭐</b>\nOne generation costs ${serviceCostsLine()}.`,
        { parseMode: "HTML" },
      );
      return;
    }
    case "/jobs": {
      const jobs = (await ctx.runQuery(internal.queries.getJobsForUser, {
        telegramId: from.id,
        limit: 5,
      })) as JobRow[];
      if (!jobs.length) {
        await telegram.sendMessage(chatId, "No jobs yet!");
        return;
      }
      const lines = jobs
        .map((j) => {
          const svc = getService(j.service);
          return `• <code>${j._id}</code> — ${svc?.config.title ?? j.service} · ${statusLabel(j.status)}`;
        })
        .join("\n");
      await telegram.sendMessage(chatId, `<b>Your last jobs</b>\n${lines}`, {
        parseMode: "HTML",
        replyMarkup: {
          inline_keyboard: jobs.map((j) => [{ text: `↩️ ${j._id.slice(0, 12)}`, callback_data: `check:${j._id}` }]),
        },
      });
      return;
    }
    case "/help":
      await telegram.sendMessage(chatId, helpText(), { parseMode: "HTML" });
      return;
    default:
      await telegram.sendMessage(chatId, `Unknown command. ${helpText()}`, { parseMode: "HTML" });
  }
}

// --- job kickoff ------------------------------------------------------------------

const INSUFFICIENT_TEXT = (cost: number) =>
  `💳 This generation costs ${cost} ⭐ and your balance is too low. ` +
  `The invoice below tops up exactly ${cost} ⭐ — pay it, then try again.`;

async function runJob(
  ctx: Ctx,
  chatId: number,
  telegramId: number,
  svc: Service,
  input: Record<string, unknown>,
): Promise<void> {
  const created = await ctx.runMutation(internal.jobs.createJob, {
    telegramId,
    service: svc.config.name,
    input,
  });

  if (!created.ok) {
    await telegram.sendInvoice(chatId, svc.config.cost, `Top up ${svc.config.cost} ⭐ for one ${svc.config.title} generation.`);
    await telegram.sendMessage(chatId, INSUFFICIENT_TEXT(svc.config.cost));
    return;
  }

  const submitted = await ctx.runAction(internal.jobs_actions.submitJob, { jobId: created.jobId });
  if (submitted.status !== "submitted") return; // failure already notified by submitJob

  const job = (await ctx.runQuery(internal.queries.getJob, { jobId: created.jobId })) as JobRow | null;
  if (!job) return;
  await telegram.sendMessage(chatId, renderStatusText(job, svc.config.title), {
    parseMode: "HTML",
    replyMarkup: statusKeyboard(job._id),
  });
}

// --- callbacks & checkout ---------------------------------------------------------

async function handleCallbackQuery(ctx: Ctx, cq: Record<string, any>): Promise<void> {
  // Answer first — otherwise the client keeps the loading spinner.
  await telegram.safe(() => telegram.answerCallbackQuery(cq.id));

  const chatId = cq.message?.chat?.id as number | undefined;
  const messageId = cq.message?.message_id as number | undefined;
  if (!cq.from || !chatId || !messageId) return;

  const data = String(cq.data ?? "");
  const sep = data.indexOf(":");
  const op = sep === -1 ? data : data.slice(0, sep);
  const value = sep === -1 ? "" : data.slice(sep + 1);

  switch (op) {
    case "buy": {
      const amount = Number(value) || 0;
      if (amount > 0) {
        await telegram.sendInvoice(chatId, amount, `Top up ${amount} ⭐ for generations.`);
      }
      return;
    }
    case "check": {
      await ctx.runAction(internal.jobs_actions.pollJob, {
        jobId: value as unknown as Id<"jobs">,
        chatId,
        messageId,
      });
      return;
    }
    case "cancel": {
      const jobId = value as unknown as Id<"jobs">;
      const res = await ctx.runMutation(internal.jobs.cancelJob, {
        jobId,
        telegramId: cq.from.id,
      });
      const job = (await ctx.runQuery(internal.queries.getJob, { jobId })) as JobRow | null;
      if (!job) {
        await telegram.safe(() => telegram.editMessageText(chatId, messageId, "🤷 Job not found."));
        return;
      }
      if (res.ok) {
        await telegram.safe(() => telegram.answerCallbackQuery(cq.id, "Cancelled — Stars refunded."));
      }
      const svc = getService(job.service);
      await telegram.safe(() =>
        telegram.editMessageText(chatId, messageId, renderStatusText(job, svc?.config.title ?? job.service)),
      );
      return;
    }
    default:
      console.warn("unknown callback op", { op });
  }
}

async function handlePreCheckout(ctx: Ctx, pcq: Record<string, any>): Promise<void> {
  // We bill only XTR invoices with our payload — accept them all.
  await telegram.safe(() => telegram.answerPreCheckoutQuery(pcq?.id));
}

// --- helpers ----------------------------------------------------------------------

function buyKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "💳 Buy 50 ⭐", callback_data: "buy:50" },
        { text: "💳 Buy 100 ⭐", callback_data: "buy:100" },
        { text: "💳 Buy 250 ⭐", callback_data: "buy:250" },
      ],
    ],
  };
}

function helpText(): string {
  const photo = photoService();
  const prompt = promptService();
  const lines = ["🤖 <b>SaaS Boilerplate Bot</b>"];
  if (photo) lines.push(photo.config.description);
  if (prompt && prompt.config.trigger.kind === "prompt") {
    lines.push(`Send ${prompt.config.trigger.command} &lt;prompt&gt; — ${prompt.config.description}`);
  }
  lines.push("", "/balance — your wallet", "/jobs — your last 5 jobs", "/help — this message", "", "Failed or timed-out generations are refunded automatically.");
  return lines.join("\n");
}

const COMMANDS = [
  { command: "start", description: "Start the bot" },
  { command: "balance", description: "Stars balance" },
  { command: "jobs", description: "Your last 5 jobs" },
  { command: "help", description: "How this bot works" },
];

async function registerCommandsOnce(ctx: Ctx): Promise<void> {
  const set = await ctx.runQuery(internal.updates_mutations.getAppState, { key: "commands_set" });
  if (set) return;
  try {
    const prompt = promptService();
    const commands = [...COMMANDS];
    if (prompt && prompt.config.trigger.kind === "prompt") {
      commands.push({
        command: prompt.config.trigger.command.replace(/^\//, ""),
        description: prompt.config.description,
      });
    }
    await telegram.setMyCommands(commands);
    await ctx.runMutation(internal.updates_mutations.setAppState, { key: "commands_set", value: true });
  } catch (e) {
    console.warn("setMyCommands failed", { reason: e instanceof Error ? e.message : String(e) });
  }
}
