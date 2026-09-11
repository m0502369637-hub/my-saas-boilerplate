// handlers/message.js — runs on every `message` update.
//
// The platform calls the default export with the unwrapped Message payload
// (update.message); the raw Update — with update_id — is on ctx.update.
// File names under handlers/ are Telegram update types and the set is closed:
// `webhook` and `cron` are NOT types, which is why this repo has no
// handlers/webhook.js or handlers/cron.js (see handlers/README.md).
//
// Routing map (the one place inputs choose a service):
//   photo (no caption)      → image_to_video   (100 ⭐, video)
//   photo captioned /restyle → photo_restyle    (75 ⭐, image)
//   /imagine <prompt>       → text_to_image     (50 ⭐, image)
import { api } from 'sdk';
import { withUpdateClaim } from 'lib/idempotency';
import { upsertUser } from 'lib/auth';
import { handleSuccessfulPayment } from 'lib/stars';
import { listUserJobs, statusLine } from 'lib/jobs';
import { maybeSweep } from 'lib/sweep';
import { getState, setState } from 'lib/app_state';
import { reply, safe } from 'lib/telegram';
import dispatchImageToVideo from 'lib/services/image_to_video/index';
import dispatchTextToImage from 'lib/services/text_to_image/index';
import dispatchPhotoRestyle from 'lib/services/photo_restyle/index';

const HELP = `🎬 <b>SaaS Boilerplate Bot</b>
Three services, one wallet:

📷 Send a photo → video (100 ⭐)
🖌 Caption a photo <code>/restyle</code> → stylised image (75 ⭐)
💡 <code>/imagine &lt;prompt&gt;</code> → image from text (50 ⭐)

/balance — your wallet
/jobs — your last 5 jobs
/help — this message

Failed or timed-out generations are refunded automatically.`;

const COMMANDS = [
  { command: 'start', description: 'Start the bot' },
  { command: 'balance', description: 'Stars balance' },
  { command: 'jobs', description: 'Your last 5 jobs' },
  { command: 'imagine', description: 'Generate an image from text (50 ⭐)' },
  { command: 'restyle', description: 'Send a photo captioned /restyle (75 ⭐)' },
  { command: 'help', description: 'How this bot works' },
];

export default async function (message, ctx) {
  return withUpdateClaim(ctx, async () => {
    // Channel posts carry no `from`; never trust message.from without a guard.
    if (!message?.chat || message.from?.is_bot) return;
    const chatId = message.chat.id;

    // A paid Stars invoice lands here as a normal message with
    // successful_payment — credit the wallet before anything else.
    if (message.successful_payment) {
      await handleSuccessfulPayment(message);
      await maybeSweep();
      return;
    }

    // This SaaS bills per user in private chats; groups get nothing.
    if (message.chat.type !== 'private') return;

    const user = await upsertUser(message.from);
    if (!user) return;

    // Photos route by caption: /restyle → photo_restyle, anything else
    // (including no caption) → image_to_video. Largest size = last entry.
    if (message.photo?.length) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      const caption = message.caption?.trim() ?? '';
      if (/^\/restyle(?:@\w+)?\b/i.test(caption)) {
        await dispatchPhotoRestyle(user, fileId);
      } else {
        await dispatchImageToVideo(user, fileId);
      }
      await maybeSweep();
      return;
    }

    const text = message.text?.trim() ?? '';
    if (!text.startsWith('/')) {
      await reply(chatId, 'Send a photo for a video, caption it /restyle for a stylised image, or try /imagine.');
      await maybeSweep();
      return;
    }

    // Strip the "@botname" suffix commands carry when used in groups.
    const cmd = text.split(/[@\s]/, 1)[0];

    switch (cmd) {
      case '/start': {
        await registerCommandsOnce();
        await reply(chatId, `Hi ${user.firstName}! ${HELP}`, { parse_mode: 'HTML' });
        break;
      }
      case '/balance':
        await reply(chatId, `💰 Balance: <b>${user.starsBalance} ⭐</b>\nVideo 100 ⭐ · Restyle 75 ⭐ · Imagine 50 ⭐`, { parse_mode: 'HTML' });
        break;
      case '/imagine': {
        // /imagine[ @botname] <prompt>
        const prompt = text.replace(/^\/imagine(?:@\w+)?\s*/i, '').trim();
        if (!prompt) {
          await reply(chatId, 'Usage: /imagine a cat astronaut floating in space');
          break;
        }
        await dispatchTextToImage(user, prompt);
        break;
      }
      case '/jobs': {
        const rows = await listUserJobs(chatId, 5);
        if (!rows.length) {
          await reply(chatId, 'No jobs yet — send a photo or try /imagine!');
          break;
        }
        const lines = rows.map((j) => `• <code>${j.id}</code> — ${statusLine(j)}`).join('\n');
        await reply(chatId, `<b>Your last jobs</b>\n${lines}`, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: rows.map((j) => [
              { text: `↩️ ${j.id.slice(3, 12)}`, callback_data: `check:${j.id}` },
            ]),
          },
        });
        break;
      }
      case '/help':
        await reply(chatId, HELP, { parse_mode: 'HTML' });
        break;
      default:
        await reply(chatId, `Unknown command. ${HELP}`, { parse_mode: 'HTML' });
    }

    // Opportunistic maintenance: timeouts + provider polls, throttled and
    // budget-bounded inside lib/sweep.js.
    await maybeSweep();
  });
}

// Register the command menu exactly once (tracked in app_state) — the Bot API
// call is cheap but there is no reason to repeat it per /start.
async function registerCommandsOnce() {
  if (await getState('commands_set')) return;
  try {
    await safe(() => api.setMyCommands({ commands: COMMANDS }));
    await setState('commands_set', true);
  } catch (e) {
    console.warn('setMyCommands failed', { reason: e?.message });
  }
}
