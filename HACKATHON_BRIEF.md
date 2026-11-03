# Project Argonaut — Meta Global AI Developer Hackathon Brief

Source: cerebralvalley.ai event page, participant guide (`/details`), submission form, and dev.meta.ai/docs/models. Collected 2026-11-01.

## Status
- Registered and accepted (Indie Dev Track). Account: `ashfaque-rifaye`.
- Pitched idea in the application: "Build a health care tech for the future of the world."
- Local project folder: empty, so we start from scratch.

## Deadlines (ET → IST)
| What | ET | IST |
|---|---|---|
| Last day for Discord troubleshooting | Tue Nov 3 | Tue Nov 3 / Wed Nov 4 |
| **Submission + $150 credit claim deadline** | **Wed Nov 4, 9:00 PM** | **Thu Nov 5, 7:30 AM** |
| Judging | Nov 5–8 | |
| Finals (top 5 per track, live) | Mon Nov 9, 12:00 PM | Mon Nov 9, 10:30 PM |
| Viral prize engagement cutoff | Nov 8 EOD | |

About 3.5 days of build time are left.

## Rules that matter
- **Public GitHub repo** is required. Teams can have up to 4 people, and solo entries are allowed.
- **New work only.** The demo must clearly show what was built during the hackathon, or the project risks disqualification.
- Must use Meta models: Meta Model API and/or the open-weight models.
- **Banned / anti-projects:** any AI that *gives medical advice* (mental-health advisor, skin detector…), basic RAG, simple image analyzers, edu chatbots, job screeners, nutrition coaches, personality analyzers, sports coaches, political or war topics.
  - ⚠️ This means the healthcare idea must not diagnose or advise. Documentation, operations, access, logistics, and admin work are fine.

## Judging (Stage 2, 0–10 each)
| Criterion | Weight | What it means for us |
|---|---|---|
| Impact | 30% | A real user with a real, quantified pain point that fits a theme |
| Use of Meta AI tooling | 25% | Go beyond one chat call. Combine models and show capabilities that are unique to Meta's models |
| Technical depth | 20% | Clean architecture, agents, evals, structured output |
| Demo | 25% | Works live and makes a great 3-minute video |

Stage 1 is a pass/fail check on theme fit and whether the project really uses Meta models. Stage 3 takes the top 5 per track, and judges watch the videos live.

## Prizes
- Indie track: $150K / $100K / $75K / $50K / $25K
- Bonus prizes (can be won alongside a track prize):
  - Most Viral on X: $20K. Post the demo on X and paste the link in the submission form.
  - Best on open weights (Muse Glimmer / Muse Spark Open): $10K
  - Community vote: $10K
  - Best Agentic Use-Case: $5K
  - Best Creative Build (Muse Image / Muse Wonder): $5K

## Meta models available
| Model | ID | Use |
|---|---|---|
| Muse Wonder | `muse-wonder-1.0` | Most capable model, for long-horizon agents. 1M context, input: text, image, video, audio, PDF |
| Muse Spark | `muse-spark-1.3` (use `1.2` for audio) | Fast agentic model with tool calling, structured output, search grounding |
| Muse Image | `muse-image-1.0` | Image generation and editing |
| Muse Voice Transcribe | `muse-voice-transcribe-1.0` | Realtime WebSocket speech-to-text with diarization, 25 languages, **code-switching**, keyword biasing |
| SAM 3.1 | `sam-3.1` | Text-prompted segmentation and tracking for images and video |
| Muse Spark Open / Muse Glimmer | open weights | Self-hosted, or via Baseten (`meta-models/muse-spark-open-1026`), Modal, or Fireworks |

The API is OpenAI-compatible: `base_url="https://api.meta.ai/v1"`, key in `MODEL_API_KEY`. It supports the Responses, Chat Completions and Messages APIs.
Docs: dev.meta.ai/docs/quickstart · cookbook: github.com/meta-models/meta-model-cookbook

## Submission form fields
Team name · track · theme (Build for Your World / Push the Frontier) · X post link (viral prize) · project description · public GitHub URL · 3-min demo video URL · how Meta products were used · why Meta's models matter · partner feedback · several survey questions · content-use consent checkbox.

## Actions only you can do
1. ✅ $150 in free credits is applied (dev.meta.ai → Billing, checked 2026-11-01). ⚠️ No payment method is on file, and **API calls are blocked until you add a card**. Set a spend limit too. Note: "While using free credits your content may be used for product improvement."
2. Create a Meta Model API key and give it to the app through a local `.env` file. Never paste the key into chat.
3. Optional: request Baseten, Modal, or Fireworks credits. These are needed only if we go for the open-weights bonus.
4. Join the hackathon Discord (#office-hours, 10–11 AM ET on weekdays).
5. Have an X account ready for the viral post.
