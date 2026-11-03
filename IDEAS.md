# Idea shortlist (2026-11-01)

> Superseded by [CONCEPT.md](CONCEPT.md), which widens the vibration idea into a general measurement agent and adds the prior-art check.

The bar: a hard, real problem with a named group of workers; something not already sold as a product; a use of Meta's models that surprises the judges; no medical advice, basic RAG or simple image analysis; and a 30-second "aha" that works live on camera.

## ⭐ Recommended: Argonaut — "your phone camera is a vibration analyzer"
**Theme:** Push the Frontier (manufacturing and energy: "understand and control a physical system")

**Problem.** Rotating machines such as pumps, motors, fans and compressors fail from imbalance, misalignment, looseness and bearing wear. The cost is unplanned downtime: Siemens' *True Cost of Downtime 2024* puts it at about $1.4T a year for the world's 500 largest companies. Large plants catch these faults early with vibration analysts, mounted sensors, or RDI's camera systems, which use dedicated industrial cameras. Small and mid-sized factories, building plant rooms and water pumping stations usually have none of these. Phone vibration apps exist, but they need the phone pressed against the machine and they don't diagnose anything.

**What it does.**
1. A technician films a running machine for about 10 s in phone slow-motion (240 fps) and describes the symptom out loud in Hindi, Tamil or English.
2. **Muse Spark** watches the video, listens to the audio and reads the nameplate (RPM, kW, pole count). It checks the capture quality and asks for a better angle or a tripod when the footage isn't good enough.
3. **SAM 3.1** segments and tracks each part ("motor housing", "pump base", "coupling", plus a static "wall" used as the reference).
4. Our own signal processing measures sub-pixel displacement inside each tracked part using phase correlation, and cancels camera shake against the static reference. It then runs an FFT and converts the peaks into orders of running speed (1×, 2×, harmonics). It also compares the phase across the coupling: a 180° difference is the misalignment signature.
5. A **Muse Wonder** agent applies a fault-signature table and ISO 20816 severity zones, then writes a diagnosis. Every claim links to its evidence: the spectrum peak, the frame crop and the measured numbers. A maintenance engineer approves the work order before it goes out.
6. After the repair, the technician re-films the machine. The agent compares before and after and states whether the fix worked, with numbers.

**Meta models, each doing a visible job:**
- Muse Spark: video plus audio understanding, nameplate reading, capture coaching
- SAM 3.1: used as a *measurement instrument*, not just a segmenter. This is the surprise.
- Muse Voice Transcribe: code-switched voice notes from the technician
- Muse Wonder: the diagnosis agent and its tool loop
- Muse Spark Open on Baseten: the same diagnosis step run on open weights. A "no data leaves the plant" mode that targets the $10K open-weight bonus.

**30-second demo.** Tape a coin to one blade of a desk fan and film it. The system flags "imbalance at 1×, high severity" and shows the evidence. Remove the coin and re-film: "1× down 85%, fix verified." Then a real-world clip, such as a building's water-pump motor.

**Bonus prizes in reach:** Best Agentic ($5K), Open-weight ($10K), Viral ($20K: "film your fan" is easy to share).

**Honest risks.** We have to verify on day 1 that sub-pixel motion is measurable from phone video. The fallback is larger-amplitude targets, which keeps the fan demo intact. The tool is advisory, and an engineer confirms every finding.

## Alternative B: LineClear — lineman safety
Line workers in India are electrocuted when supply is restored or back-fed while they are still on the pole. The shutdown is arranged in a code-switched phone call, and the safety earths are checked by eye.
- Voice Transcribe captures both sides of the "line clear" call with diarization and enforces read-back of the feeder ID.
- A short video then verifies that earthing is attached on every phase before anyone climbs, and that all earths are removed before the line is re-energized.

This has very high human stakes, and we found no product that does voice plus video verification. The catch is the demo: we would need a mock rig of a pole with earthing equipment.

## Alternative C: Railway signal-circuit change verifier
The 2023 Balasore crash was traced to wrong wiring and labelling during signalling work. This would verify each wiring change in a relay rack against the approved diagram before the circuit is restored. The story is powerful, but it's the same "plan vs. seen" pattern as TrueSplice, and the topic has become politically charged.
