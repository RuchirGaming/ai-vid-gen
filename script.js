    import { Lfm2Mobile } from "./lfm2_5.js";

    // Streamed markdown → HTML. `streamdown` is React-only, so we use `marked` — the parser it is
    // built on — loaded lazily from a CDN. Until it loads (or if the CDN is unreachable) we fall
    // back to the tiny inline renderer below, so chat never depends on it.
    // KaTeX (loaded after marked) renders the LaTeX math the model emits (\( … \) inline, \[ … \]
    // display). It's a pure enhancement: if its CDN fails, markdown still works and math shows as raw
    // LaTeX, exactly as before.
    let marked = null;
    let katexLib = null;
    const katexCache = new Map(); // memoize math renders so re-rendering on each stream frame is cheap
    // Per-render scratch: while a buffered render is in flight, the KaTeX extension stashes each
    // equation's (trusted, verbose) HTML here and emits a tiny comment placeholder instead. That keeps
    // marked's output — and especially the sanitiser's element walk — from having to parse KaTeX's
    // hundreds of spans on every frame; renderAssistant splices the real HTML back in at the end.
    let katexFragments = null;
    import("https://esm.sh/marked@17")
      .then((m) => {
        marked = m.marked;
        marked.use({ gfm: true, breaks: true });
        return import("https://esm.sh/katex@0.16")
          .then((k) => { katexLib = k.default ?? k; marked.use(makeKatexExtension()); })
          .catch(() => { /* no KaTeX — math stays as raw LaTeX, markdown still renders */ });
      })
      .catch(() => { marked = null; });

    // A marked extension that turns the model's LaTeX delimiters into rendered KaTeX. Both run at the
    // inline level so display math (\[ … \], emitted as consecutive lines inside one paragraph) is
    // caught wherever it appears — including inside list items and bold headers. Incomplete math mid-
    // stream simply doesn't match (the closing delimiter is required), so it renders once it's whole.
    function makeKatexExtension() {
      const inline = {
        name: "katexInline", level: "inline",
        start(src) { return src.match(/\\\(/)?.index; },
        tokenizer(src) {
          const m = /^\\\(([\s\S]+?)\\\)/.exec(src);
          if (m) return { type: "katexInline", raw: m[0], text: m[1] };
        },
        renderer(token) { return stashKatex(token.text, false); },
      };
      const block = {
        name: "katexBlock", level: "inline",
        start(src) { return src.match(/\\\[/)?.index; },
        tokenizer(src) {
          const m = /^\\\[([\s\S]+?)\\\]/.exec(src);
          if (m) return { type: "katexBlock", raw: m[0], text: m[1] };
        },
        renderer(token) { return stashKatex(token.text, true); },
      };
      return { extensions: [inline, block] };
    }

    function renderKatex(text, display) {
      const key = (display ? "d:" : "i:") + text;
      let html = katexCache.get(key);
      if (html === undefined) {
        try { html = katexLib.renderToString(text.trim(), { throwOnError: false, displayMode: display }); }
        catch { html = escapeHtml(text); }
        katexCache.set(key, html);
      }
      return html;
    }

    // Render the (cached) KaTeX, but during a buffered render emit a tiny comment placeholder and stash
    // the markup. renderAssistant sanitises the lightweight markdown HTML first, then splices the
    // trusted KaTeX back in — so the sanitiser never has to walk an equation's hundreds of spans.
    function stashKatex(text, display) {
      const html = renderKatex(text, display);
      if (!katexFragments) return html;
      return `<!--katex:${katexFragments.push(html) - 1}-->`;
    }

    // Drop a trailing, not-yet-closed math block (the model writes left-to-right, so only the LAST
    // opening delimiter can still be open). Returns the text cut at that delimiter, or unchanged when
    // every \( and \[ already has its matching close.
    function trimIncompleteMath(text) {
      let cut = -1;
      for (const [open, close] of [["\\[", "\\]"], ["\\(", "\\)"]]) {
        const lastOpen = text.lastIndexOf(open);
        if (lastOpen !== -1 && text.indexOf(close, lastOpen + open.length) === -1) {
          if (cut === -1 || lastOpen < cut) cut = lastOpen;
        }
      }
      return cut === -1 ? text : text.slice(0, cut);
    }

    const $ = (id) => document.getElementById(id);

    // --- refs: landing / boot ---
    const heroEl = document.querySelector(".hero");
    const ctaBtn = $("cta");
    const hintText = $("hint-text");
    const modelCardBtn = $("modelcard-btn");
    const page2El = $("page2");
    const bootBar = $("boot-bar");
    const bootStep = $("boot-step");
    const bootPct = $("boot-pct");
    const gpuChip = $("gpu-chip");
    const bootError = $("boot-error");
    const bootRetryBtn = $("boot-retry");

    // --- refs: chat ---
    const chatEl = $("chat");
    const toHeroBtn = $("toHero");
    const statusEl = $("status");
    const statusText = $("statusText");
    const threadScroll = $("threadScroll");
    const thread = $("thread");
    const input = $("input");
    const sendBtn = $("sendBtn");
    const stopBtn = $("stopBtn");
    const clearBtn = $("clearBtn");
    const hint = $("hint");
    const liveStat = $("liveStat");
    const kernelsBtnChat = $("kernelsBtnChat");
    const kernelsOverlay = $("kernelsOverlay");

    // The model this demo loads. Any LFM2.5 GGUF repo id works — the loader derives the Q4_0 file
    // name from the id (e.g. "LiquidAI/LFM2.5-230M-GGUF" → LFM2.5-230M-Q4_0.gguf).
    const MODEL_ID = "LiquidAI/LFM2.5-230M-GGUF";
    const MODEL_CARD_URL = `https://huggingface.co/${MODEL_ID}`;

    // Welcome example prompts. A small model like this shines at structured data tasks, so the seeds
    // are extraction / classification jobs. Each button shows a SHORT summary; clicking sends the full
    // prompt (with sample input) — see renderSeeds + the seed click handler.
    const SEED_EXAMPLES = [
      {
        label: "Extract contact details to JSON",
        prompt: `Extract the name, company, email, and phone number from this text as JSON:\n\n"Hi, I'm Priya Nair from Acme Robotics — reach me at priya.nair@acme.dev or +1 (415) 555-0173."`,
      },
      {
        label: "Solve a quadratic equation",
        prompt: `Solve for x: 2x² + 5x - 3 = 0`,
      },
      {
        label: "Pull out the dates and amounts",
        prompt: `Extract the relevant information and create a well-formatted table with appropriate headers:\n\n"Invoice #4471, dated April 9 2026, is due May 1. Subtotal is $3,820.00 with 7% tax and a $500 credit applied."`,
      },
    ];

    let model = null;
    let kernels = [];
    let kxCopySource = "";
    let messages = [];
    let abortController = null;
    let isGenerating = false;
    let loadStarted = false; // a load attempt is in flight or done
    let bootEntered = false; // the boot screen is showing (guards double-entry)
    let loadBlocked = false; // device can't run the model — block the CTA
    let renderScheduled = false;
    let renderState = null;
    let lastStreamRenderAt = 0; // throttle streamed renders so fast decode isn't taxed by re-parsing
    // Boot-bar state: `bootTarget` is the monotonic real target; `bootShown` is the displayed value
    // eased toward it every frame; a gentle asymptotic `creep` fills indeterminate (non-download) waits.
    let bootTarget = 0, bootShown = 0, bootRaf = 0, creepRaf = 0, creepCeil = 0;

    // The scene (if it loads) calls this to enter the boot screen, and reads canLoad() before
    // allowing the hold-to-charge blast.
    window.LFMApp = { beginBoot, canLoad: () => !loadBlocked };

    // Reveal the hero on the first painted frame, independent of whether the 3D scene ever loads.
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add("ready")));

    // Populate the welcome's example seeds (short labels; full prompts live in data-prompt).
    renderSeeds(document.querySelector("#welcome .seeds"));

    // --- availability gate: warn + block BEFORE the user invests in the load ---
    if (!navigator.gpu) {
      blockLoad("WebGPU isn't available here. Try a recent Chrome or Edge, or enable WebGPU in your browser.");
    } else {
      // Cheap fast-path: reads adapter limits + the tiny GGUF header, no device/weights.
      Lfm2Mobile.checkAvailability(MODEL_ID)
        .then((res) => { if (!model && !loadStarted && res && !res.ok && res.reason) blockLoad(res.reason); })
        .catch(() => { /* best-effort — fall back to the check at load time */ });
    }

    function blockLoad(reason) {
      loadBlocked = true;
      ctaBtn.disabled = true;
      ctaBtn.textContent = "UNAVAILABLE ON THIS DEVICE";
      if (hintText) hintText.textContent = reason.length > 96 ? reason.slice(0, 94) + "…" : reason;
    }

    // --- wiring ---
    // CTA → blast (if the 3D scene is up) or straight to boot. Holding the canvas also routes through
    // the scene, which honours canLoad() before charging.
    ctaBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (loadBlocked) return;
      if (window.LFMScene) window.LFMScene.triggerBlast();
      else beginBoot();
    });
    modelCardBtn.addEventListener("click", () => window.open(MODEL_CARD_URL, "_blank", "noopener"));
    kernelsBtnChat.addEventListener("click", openKernels);
    toHeroBtn.addEventListener("click", backToHero);
    bootRetryBtn.addEventListener("click", (e) => { e.preventDefault(); hideBootError(); startRealLoad(); });

    kernelsOverlay.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeKernels(); });
    $("kxList").addEventListener("scroll", updateListFade, { passive: true });
    $("kxCopy").addEventListener("click", copyKernel);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !kernelsOverlay.hidden) closeKernels(); });

    sendBtn.addEventListener("click", send);
    stopBtn.addEventListener("click", () => abortController?.abort());
    clearBtn.addEventListener("click", clearChat);
    input.addEventListener("input", () => { autoGrow(); refreshSend(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) send(); }
    });
    document.addEventListener("click", (e) => {
      const seed = e.target.closest(".seed");
      if (!seed || seed.disabled || !model || isGenerating) return;
      input.value = seed.dataset.prompt || seed.textContent; // button shows a summary; send the full prompt
      send();
    });

    // ====================================================================
    // Boot / model load
    // ====================================================================

    // Enter the boot screen and kick off the real load. Idempotent — the scene fires this ~0.9s into
    // the blast, and the no-scene CTA path fires it directly; either way only the first call counts.
    function beginBoot() {
      if (bootEntered) return;
      bootEntered = true;
      ctaBtn.disabled = true;
      heroEl.classList.add("fade-out");
      page2El.classList.add("show");
      updateGpuChip();
      startRealLoad();
    }

    function updateGpuChip() {
      const ok = !!navigator.gpu;
      gpuChip.textContent = ok ? "WebGPU available" : "WebGPU unavailable";
      gpuChip.classList.toggle("ok", ok);
      gpuChip.classList.toggle("bad", !ok);
    }

    async function startRealLoad() {
      // Already loaded (e.g. user went back to the intro and re-entered): show ready instantly.
      if (model) {
        setBootProgressImmediate(1);
        bootStep.textContent = "Ready · entering chat…";
        setTimeout(enterChat, 300);
        return;
      }
      if (loadStarted) return;
      loadStarted = true;
      hideBootError();
      setBootProgressImmediate(0);
      startCreep(0.05); // smoothly fill the device-request + tokenizer + GGUF-header gap (no real bytes yet)
      bootStep.textContent = "Requesting WebGPU device…";

      try {
        // No availability probe here: the page-load checkAvailability() already gated the CTA, and
        // load() runs its OWN header-only device gate before the big download (reusing the cached
        // header). A probe here would just re-read the GGUF header a third time.
        // The download (→~86%) AND the GPU weight upload (→95%) drive the bar via onLoadProgress.
        model = await Lfm2Mobile.load(MODEL_ID, { onProgress: onLoadProgress });
        stopCreep();
        setBootProgress(0.95);

        // Warm the kernels thoroughly: warmup() prefills + decodes a long-ish run, compiling every
        // decode pipeline variant AND ramping the GPU clock, so the user's FIRST real reply runs at
        // steady-state speed.
        bootStep.textContent = "Warming up kernels…";
        startCreep(0.98); await model.warmup(); stopCreep();

        setBootProgress(1);
        gpuChip.textContent = "WebGPU ready"; gpuChip.classList.add("ok"); gpuChip.classList.remove("bad");
        bootStep.textContent = "Ready · entering chat…";
        // Loaded — transition straight into the chat (a brief beat so "Ready · 100%" registers).
        setTimeout(enterChat, 450);
      } catch (error) {
        stopCreep();
        console.error(error);
        loadStarted = false;
        model = null;
        showBootError(String(error?.message ?? error));
      }
    }

    function labelFor(status) {
      return {
        init: "Requesting WebGPU device…",
        tokenizer: "Loading tokenizer…",
        weights: "Downloading weights…",
        ready: "Ready.",
      }[status] ?? status;
    }

    function onLoadProgress(event) {
      if (event.status !== "weights") {
        bootStep.textContent = labelFor(event.status);
        setPhaseProgress(event.status, event.fraction);
        return;
      }
      // The model's `fraction` already spans BOTH the byte download (→0.9) and the GPU upload
      // (0.9→1.0), in order, so drive the bar off it directly (mapped 5%→95%, leaving 95%→100% for
      // warmup). The upload phase advances + repaints because the loader yields between tensors.
      const fraction = finiteNumber(event.fraction) ? clamp(event.fraction, 0, 1) : null;
      if (fraction !== null) setBootProgress(0.05 + 0.90 * fraction);
      bootStep.textContent = formatWeightProgress(event, fraction);
    }

    // Map each load phase onto a slice of the bar weighted by its real cost. The byte download (the
    // ~209 MB GGUF, which dwarfs everything else) owns 5%→90% and is tracked exactly off loaded/total;
    // the small head (device + tokenizer) and the GPU tail (prepare + warmup + prime) get the rest.
    // `ready` (emitted by load() once weights are resident) caps at 90% so the tail owns 90%→100%.
    function setPhaseProgress(status, frac) {
      const [lo, hi] = status === "weights"
        ? [0.05, 0.90]
        : ({ init: [0, 0.02], tokenizer: [0.02, 0.05], ready: [0.90, 0.90] }[status] ?? [0, 1]);
      const f = finiteNumber(frac) ? clamp(frac, 0, 1) : 0;
      setBootProgress(lo + (hi - lo) * f);
    }

    // Set a new monotonic target; a single rAF loop eases the displayed bar toward it (smooth glide,
    // never a hard jump, never backwards).
    function setBootProgress(value) {
      if (!finiteNumber(value)) return;
      bootTarget = Math.max(clamp(value, 0, 1), bootTarget);
      if (!bootRaf) bootRaf = requestAnimationFrame(stepBootBar);
    }
    function stepBootBar() {
      const gap = bootTarget - bootShown;
      bootShown += gap < 0.0015 ? gap : gap * 0.16; // close 16% of the remaining gap each frame
      bootBar.style.width = `${(bootShown * 100).toFixed(2)}%`;
      bootPct.textContent = `${Math.round(bootShown * 100)}%`;
      bootRaf = bootShown < bootTarget - 0.0002 ? requestAnimationFrame(stepBootBar) : 0;
    }
    // Snap both target + displayed value (used for resets and the already-loaded fast path).
    function setBootProgressImmediate(value) {
      stopCreep();
      if (bootRaf) { cancelAnimationFrame(bootRaf); bootRaf = 0; }
      bootTarget = bootShown = clamp(value, 0, 1);
      bootBar.style.width = `${(bootShown * 100).toFixed(2)}%`;
      bootPct.textContent = `${Math.round(bootShown * 100)}%`;
    }
    // Gentle asymptotic creep toward `ceiling` — fills indeterminate, no-event waits (GGUF header
    // fetch, GPU warmup, first-token prime) so the bar never looks frozen. Real byte progress, being
    // monotonic-max and larger, overtakes it; the creep auto-stops once the target passes the ceiling.
    function startCreep(ceiling) {
      creepCeil = ceiling;
      if (!creepRaf) creepRaf = requestAnimationFrame(creepStep);
    }
    function creepStep() {
      const gap = creepCeil - bootTarget;
      if (gap > 0.0005) { setBootProgress(bootTarget + gap * 0.02); creepRaf = requestAnimationFrame(creepStep); }
      else creepRaf = 0;
    }
    function stopCreep() { if (creepRaf) { cancelAnimationFrame(creepRaf); creepRaf = 0; } }

    // Plain-text (textContent-safe) progress label.
    function formatWeightProgress(event, fraction) {
      const kind = event.kind ?? inferProgressKind(event);
      const pct = fraction === null ? "" : ` (${Math.round(fraction * 100)}%)`;
      const loaded = finiteNumber(event.loaded) ? event.loaded : null;
      const total = finiteNumber(event.total) ? event.total : null;
      if (kind === "bytes") {
        const verb = event.fromCache ? "Loading cached weights" : "Downloading weights";
        if (loaded !== null && total !== null) return `${verb}: ${formatBytes(loaded)} / ${formatBytes(total)}${pct}`;
        if (total !== null) return `${verb}: ${formatBytes(total)} total`;
        return `${event.message || verb}…`;
      }
      if (loaded !== null && total !== null) {
        const label = event.message ? ` (${event.message})` : "";
        return `Preparing GPU weights: ${formatInteger(loaded)} / ${formatInteger(total)} tensors${pct}${label}`;
      }
      return event.message ? `Preparing GPU weights: ${event.message}` : "Preparing GPU weights…";
    }

    function inferProgressKind(event) {
      if (event.kind === "bytes" || event.kind === "tensors") return event.kind;
      if (finiteNumber(event.total) && event.total > 1_000_000) return "bytes";
      return "tensors";
    }

    function showBootError(message) {
      gpuChip.textContent = "Load failed";
      gpuChip.classList.add("bad"); gpuChip.classList.remove("ok");
      const cantRun = /cannot run on this GPU\/browser|maxBufferSize|storage buffers per shader stage|WebGPU isn't available/i.test(message);
      bootStep.textContent = cantRun ? "This device can't run the model" : "Couldn't load the model";
      bootError.querySelector(".boot-error-msg").textContent = message; // textContent: safe + preserves newlines
      bootError.classList.add("show");
    }
    function hideBootError() { bootError.classList.remove("show"); }

    // ====================================================================
    // Screen transitions
    // ====================================================================

    function enterChat() {
      if (!model || chatEl.classList.contains("show")) return;
      window.LFMScene?.stop(); // free the GPU for inference — no 3D render competing
      page2El.classList.remove("show");
      heroEl.classList.add("fade-out");
      chatEl.classList.add("show");
      document.body.classList.add("chatting"); // freeze + hide the animated background layers
      input.disabled = false;
      clearBtn.disabled = false;
      setSeedButtonsEnabled(true);
      setStatus("ready", "Ready · on-device");
      refreshSend();
      input.focus();
    }

    // Back to the landing intro. The model + conversation persist; re-loading from the hero jumps
    // straight to "Ready" since the weights are already resident.
    function backToHero() {
      chatEl.classList.remove("show");
      document.body.classList.remove("chatting");
      page2El.classList.remove("show");
      heroEl.classList.remove("fade-out");
      bootEntered = false;
      if (!loadBlocked) ctaBtn.disabled = false;
      hideBootError();
      setBootProgressImmediate(0);
      bootStep.textContent = "Fetching LFM2.5 weights";
      if (window.LFMScene) window.LFMScene.replay();
    }

    function setStatus(state, text) {
      statusEl.className = "status" + (state ? " " + state : "");
      if (text !== undefined) statusText.textContent = text;
    }

    // ====================================================================
    // Chat
    // ====================================================================

    async function send() {
      const text = input.value.trim();
      if (!text || !model || isGenerating) return;

      removeWelcome();
      input.value = "";
      autoGrow(); refreshSend();

      appendUserMessage(text);
      messages.push({ role: "user", content: text });

      const assistant = appendAssistantMessage();
      const bubble = assistant.querySelector(".bubble");
      bubble.innerHTML = '<span class="thinking"><span></span><span></span><span></span></span>';
      scrollDown();

      setGenerating(true);
      abortController = new AbortController();

      let reply = "";
      let startedAt = 0, firstTokenAt = 0, endedAt = 0, generatedTokens = 0;

      try {
        const stream = model.generate(messages, { maxNewTokens: 4096, signal: abortController.signal });
        startedAt = performance.now();
        for await (const { text: full } of stream) {
          const now = performance.now();
          if (!firstTokenAt) firstTokenAt = now;
          generatedTokens++;
          reply = full;
          scheduleAssistantRender(bubble, reply);
          updateLiveStat({ startedAt, firstTokenAt, now, generatedTokens });
        }
      } catch (error) {
        console.error(error);
        if (!reply) reply = `_Stopped: ${String(error?.message ?? error)}_`;
      } finally {
        endedAt = performance.now();
        renderState = null; // cancel any pending coalesced render; show the final reply now
        renderAssistant(bubble, reply, false);
        appendMeta(assistant, { startedAt, firstTokenAt, endedAt, generatedTokens });
        scrollDown();
        messages.push({ role: "assistant", content: reply });
        setGenerating(false);
        liveStat.textContent = "";
        abortController = null;
        input.focus();
      }
    }

    function setGenerating(on) {
      isGenerating = on;
      input.disabled = on;
      clearBtn.disabled = on;
      sendBtn.style.display = on ? "none" : "";
      stopBtn.style.display = on ? "grid" : "none";
      setStatus(on ? "busy" : "ready", on ? "Generating…" : "Ready · on-device");
      hint.textContent = on ? "Generating on-device…" : "Runs fully on-device — nothing leaves your machine";
      refreshSend();
    }

    // Called once per token (1000+/s). The DOM write is throttled to ~LIVE_STAT_MS so the readout
    // doesn't force a style/layout pass every token; the eye can't read faster than this anyway, and
    // the final, exact tok/s is shown in the message meta line once generation settles.
    const LIVE_STAT_MS = 120;
    let lastLiveStatAt = 0;
    function updateLiveStat({ startedAt, firstTokenAt, now, generatedTokens }) {
      if (generatedTokens <= 1) { liveStat.textContent = `TTFT ${(firstTokenAt - startedAt).toFixed(0)} ms`; lastLiveStatAt = now; return; }
      if (now - lastLiveStatAt < LIVE_STAT_MS) return;
      lastLiveStatAt = now;
      const decodeSeconds = Math.max((now - firstTokenAt) / 1000, 1e-9);
      const tps = (generatedTokens - 1) / decodeSeconds;
      liveStat.textContent = `${tps.toFixed(0)} tok/s`;
    }

    function clearChat() {
      messages = [];
      model?.reset();
      thread.replaceChildren(createWelcome());
      clearBtn.disabled = !model;
      setSeedButtonsEnabled(Boolean(model));
      input.focus();
    }

    function appendUserMessage(text) {
      const msg = document.createElement("div");
      msg.className = "msg user";
      msg.appendChild(roleLabel("You"));
      const bubble = document.createElement("div");
      bubble.className = "bubble user";
      bubble.textContent = text;
      msg.appendChild(bubble);
      thread.appendChild(msg);
      scrollDown();
      return msg;
    }

    function appendAssistantMessage() {
      const msg = document.createElement("div");
      msg.className = "msg assistant";
      msg.appendChild(roleLabel("LFM2.5"));
      const bubble = document.createElement("div");
      bubble.className = "bubble assistant";
      msg.appendChild(bubble);
      thread.appendChild(msg);
      return msg;
    }

    function roleLabel(text) {
      const label = document.createElement("div");
      label.className = "role";
      label.textContent = text;
      return label;
    }

    function appendMeta(msg, timing) {
      if (timing.generatedTokens <= 0) return;
      const stats = generationStats(timing);
      const meta = document.createElement("div");
      meta.className = "meta";
      const parts = [`${timing.generatedTokens} tok`, `TTFT ${stats.ttftMs.toFixed(0)} ms`];
      if (stats.decodeTokensPerSecond > 0) parts.push(`${stats.decodeTokensPerSecond.toFixed(1)} tok/s`);
      meta.textContent = parts.join("  ·  ");
      msg.appendChild(meta);
    }

    function generationStats({ startedAt, firstTokenAt, endedAt, generatedTokens }) {
      if (generatedTokens <= 0 || !startedAt || !firstTokenAt || !endedAt) return { ttftMs: 0, decodeTokensPerSecond: 0 };
      const decodeTokens = Math.max(generatedTokens - 1, 0);
      const decodeSeconds = Math.max((endedAt - firstTokenAt) / 1000, 1e-9);
      return { ttftMs: firstTokenAt - startedAt, decodeTokensPerSecond: decodeTokens > 0 ? decodeTokens / decodeSeconds : 0 };
    }

    // Coalesce streamed renders and cap them to ~STREAM_RENDER_MS apart. marked re-parses the full
    // reply each call, so at 1000+ tok/s rendering every animation frame (≈60/s) steals main-thread
    // time from the decode loop; throttling to ≈30/s stays smooth to the eye while halving that cost.
    // The final, complete render always runs from generate()'s finally block.
    const STREAM_RENDER_MS = 33;
    function scheduleAssistantRender(bubble, raw) {
      renderState = { bubble, raw };
      if (renderScheduled) return;
      renderScheduled = true;
      const tick = () => {
        if (!renderState) { renderScheduled = false; return; }
        if (performance.now() - lastStreamRenderAt < STREAM_RENDER_MS) {
          requestAnimationFrame(tick); // too soon — recheck next frame
          return;
        }
        renderScheduled = false;
        lastStreamRenderAt = performance.now();
        renderAssistant(renderState.bubble, renderState.raw, true);
        scrollDown();
      };
      requestAnimationFrame(tick);
    }

    function renderAssistant(bubble, raw, withCaret) {
      // While streaming (withCaret) with KaTeX active, hide a trailing in-progress math block (an open
      // \( or \[ whose closing delimiter hasn't streamed in yet) so the user never sees raw LaTeX — it
      // appears, fully rendered, the moment the block is complete. The final render passes the text
      // verbatim, so nothing is ever dropped.
      const text = (withCaret && katexLib) ? trimIncompleteMath(raw || "") : (raw || "");
      if (marked) {
        try {
          katexFragments = [];
          let html = sanitizeHtml(marked.parse(text));
          if (katexFragments.length) {
            html = html.replace(/<!--katex:(\d+)-->/g, (_, i) => katexFragments[+i] ?? "");
          }
          bubble.innerHTML = html;
          if (withCaret) appendCaret(bubble);
          return;
        } catch { /* fall through to the simple renderer */ }
        finally { katexFragments = null; }
      }
      const safe = escapeHtml(text);
      const paragraphs = safe.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      if (paragraphs.length === 0) { bubble.textContent = ""; return; }
      bubble.innerHTML = paragraphs.map((p) => `<p>${formatInline(p).replace(/\n/g, "<br>")}</p>`).join("");
      if (withCaret) appendCaret(bubble);
    }

    function appendCaret(bubble) {
      const caret = document.createElement("span");
      caret.className = "caret";
      (bubble.querySelector("p:last-of-type") || bubble).appendChild(caret);
    }

    // Strip anything executable from the model's markdown before inserting it (defence in depth).
    function sanitizeHtml(html) {
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      tpl.content.querySelectorAll("script,style,iframe,object,embed,link,meta,form").forEach((el) => el.remove());
      tpl.content.querySelectorAll("*").forEach((el) => {
        for (const attr of [...el.attributes]) {
          const name = attr.name.toLowerCase();
          if (name.startsWith("on") || ((name === "href" || name === "src") && /^\s*(javascript|data):/i.test(attr.value))) {
            el.removeAttribute(attr.name);
          }
        }
      });
      return tpl.innerHTML;
    }

    function formatInline(text) {
      return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+?)`/g, "<code>$1</code>");
    }

    function removeWelcome() { $("welcome")?.remove(); }

    // Build the welcome example buttons: short summary as the label, the full prompt in `data-prompt`
    // (sent on click). Built via DOM so multi-line prompts need no HTML escaping.
    function renderSeeds(container) {
      if (!container) return;
      container.replaceChildren(...SEED_EXAMPLES.map((s) => {
        const b = document.createElement("button");
        b.className = "seed";
        b.type = "button";
        b.dataset.prompt = s.prompt;
        b.textContent = s.label;
        return b;
      }));
    }

    function createWelcome() {
      const welcome = document.createElement("div");
      welcome.className = "welcome";
      welcome.id = "welcome";
      welcome.innerHTML = `
        <h2>What's on your <span class="thin">mind today?</span></h2>
        <p>LFM2.5 runs entirely on your device.</p>
        <div class="seeds"></div>`;
      renderSeeds(welcome.querySelector(".seeds"));
      return welcome;
    }

    function setSeedButtonsEnabled(enabled) {
      document.querySelectorAll(".seed").forEach((s) => { s.disabled = !enabled; });
    }
    function refreshSend() { sendBtn.disabled = isGenerating || !model || input.value.trim() === ""; }
    function autoGrow() { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }
    function scrollDown() { threadScroll.scrollTop = threadScroll.scrollHeight; }

    // ====================================================================
    // Kernels viewer — the real rendered WGSL the model compiled on this GPU
    // ====================================================================

    function openKernels() {
      kernels = model ? (model.runtime.getRenderedShaders?.() ?? []) : [];
      const list = $("kxList");
      list.replaceChildren();
      $("kxSub").textContent = kernels.length
        ? `${kernels.length} WGSL compute shaders · written & optimized by Fable 5 + Opus 4.8 · running on your GPU`
        : (model ? "No kernels compiled yet — send a message first." : "Load the model to inspect its compiled kernels.");
      kernels.forEach((k, i) => {
        const item = document.createElement("button");
        item.className = "kx-item";
        item.type = "button";
        item.textContent = k.name;
        item.addEventListener("click", () => selectKernel(i));
        list.appendChild(item);
      });
      [...list.children].forEach((el) => el.classList.remove("active"));
      $("kxSource").hidden = true;
      $("kxIntro").hidden = false;
      kxCopySource = "";
      kernelsOverlay.hidden = false;
      document.body.classList.add("kx-locked");
      list.scrollTop = 0;
      requestAnimationFrame(updateListFade);
    }

    function updateListFade() {
      const list = $("kxList");
      const atEnd = list.scrollHeight <= list.clientHeight + 4
        || list.scrollTop >= list.scrollHeight - list.clientHeight - 4;
      list.parentElement.classList.toggle("at-end", atEnd);
    }

    function selectKernel(i) {
      const k = kernels[i];
      if (!k) return;
      $("kxIntro").hidden = true;
      $("kxSource").hidden = false;
      [...$("kxList").children].forEach((el, j) => el.classList.toggle("active", j === i));
      $("kxName").textContent = k.name;
      $("kxLines").textContent = `${k.source.split("\n").length} lines`;
      $("kxCode").innerHTML = highlightWgsl(k.source);
      $("kxCode").parentElement.scrollTop = 0;
      kxCopySource = k.source;
    }

    function closeKernels() {
      kernelsOverlay.hidden = true;
      document.body.classList.remove("kx-locked");
    }

    async function copyKernel() {
      if (!kxCopySource) return;
      try {
        await navigator.clipboard.writeText(kxCopySource);
        const btn = $("kxCopy");
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = "Copy"; }, 1200);
      } catch { /* clipboard blocked — ignore */ }
    }

    const WGSL_KEYWORDS = new Set(["fn","let","var","const","const_assert","struct","if","else","for","loop","return","break","continue","switch","case","default","while","override","enable","requires","discard","alias","true","false","workgroup","storage","uniform","function","private","read","write","read_write","bitcast"]);
    const WGSL_TYPES = new Set(["u32","i32","f32","f16","bool","vec2","vec3","vec4","mat2x2","mat3x3","mat4x4","mat2x3","mat3x2","mat2x4","mat4x2","mat3x4","mat4x3","array","atomic","ptr","sampler"]);
    const WGSL_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(@[A-Za-z_]\w*)|([A-Za-z_]\w*)|(\d[\w.]*)|(\s+)|([\s\S])/g;

    function highlightWgsl(src) {
      let out = "";
      WGSL_TOKEN.lastIndex = 0;
      let m;
      while ((m = WGSL_TOKEN.exec(src))) {
        const [tok, comment, attr, ident, num, ws] = m;
        if (comment) out += `<span class="k-cm">${escapeHtml(comment)}</span>`;
        else if (attr) out += `<span class="k-at">${escapeHtml(attr)}</span>`;
        else if (ident) {
          const cls = WGSL_KEYWORDS.has(ident) ? "k-kw" : WGSL_TYPES.has(ident) ? "k-ty" : null;
          out += cls ? `<span class="${cls}">${ident}</span>` : escapeHtml(ident);
        }
        else if (num) out += `<span class="k-nu">${escapeHtml(num)}</span>`;
        else if (ws) out += ws;
        else out += escapeHtml(tok);
      }
      return out;
    }

    // ---- small helpers ----
    function finiteNumber(v) { return typeof v === "number" && Number.isFinite(v); }
    function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
    function formatInteger(v) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v); }
    function formatBytes(bytes) {
      const units = ["B", "KB", "MB", "GB"]; let v = bytes, u = 0;
      while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
      const digits = u === 3 ? 2 : (v >= 10 || u === 0 ? 0 : 1);
      return `${v.toFixed(digits)} ${units[u]}`;
    }
    const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    function escapeHtml(v) {
      return v.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
    }
  </script>

  <!-- ============================================================
       SCENE MODULE — the Three.js 3D logo intro. Imports `three`
       from a CDN; if that fails, this module simply never runs and
       window.LFMScene stays null, so the app degrades to a static
       hero (the LOAD MODEL button still works). On the blast
       transition it calls window.LFMApp.beginBoot().
       ============================================================ -->
  <script type="module">
  import * as THREE from 'three';
  import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
  import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
  import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
  import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
  import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
  import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

  /* =====================================================================
     TUNABLES
     ===================================================================== */
  const CFG = {
    TARGET_HEIGHT: 4.6, EXTRUDE_DEPTH: 3.8, BEVEL_THICK: 0.2, BEVEL_SIZE: 0.08,
    BASE_EMISSIVE: 0.03, HOVER_EMISSIVE: 0.06, CHARGE_EMISSIVE: 1.0,
    WARM_BASE: 30, ORBIT_R: 4.6,
    BLOOM_BASE: 0.6, BLOOM_RADIUS: 0.32, BLOOM_THRESHOLD: 0.72, EXPOSURE: 1.12,
    INTRO_DELAY: 0.25, INTRO_STAGGER: 0.14, INTRO_DUR: 1.5,
    EXPAND_STRENGTH: 0.42, EXPAND_RANGE: 1.9,
    FOV: 38, CAM_Z: 12, BASE_ROT: { x:-0.30, y:-0.5, z:0.08 },
    SHIMMY_AMP: 0.13, SHIMMY_SPEED: 0.85,
  };

  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const lerp=(a,b,t)=>a+(b-a)*t;
  const rand=(a,b)=>a+Math.random()*(b-a);
  const easeOutExpo=t=>t>=1?1:1-Math.pow(2,-10*t);

  const EMISSIVE_BASE=new THREE.Color(0xff5a18);
  const EMISSIVE_HOT =new THREE.Color(0xffb070);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduceMotion ? 0.3 : 1.0;

  /* ---------- DOM refs ---------- */
  const canvas=document.getElementById('scene');
  const sceneWrap=document.getElementById('scene-wrap');
  const flashEl=document.getElementById('flash');

  /* ===================================================================== */
  let renderer,scene,camera,composer,bloom,clock;
  let tiltGroup,logoGroup;
  let material;
  let warmLight;
  const pieces=[];
  const solidMeshes=[];
  const orbs=[];
  const sparks=[];
  const particleData=[];
  let ambGroup, particles, shockwave;
  let shatterMesh, shatterMat, shatterUniform;
  let raycaster;

  // state machine
  let state='INTRO';
  let stateTime=0, elapsed=0;
  let charge=0, floatLevel=0, hoverGlow=0, camKick=0;
  let isHolding=false, autoBlast=false, transitionStarted=false;
  let sceneActive=true; // false → render loop is parked (frees the GPU for inference)
  let rafId=null;

  const pointerN={x:0,y:0};

  function setState(s){ state=s; stateTime=0; }
  function canLoad(){ return !window.LFMApp || window.LFMApp.canLoad(); }

  /* ---------- SVG → extruded geometry ---------- */
  const LOGO_PATH_D="M12.028 8.546l-.008.005 3.03 5.25a3.94 3.94 0 01.643 2.162c0 .754-.212 1.46-.58 2.062l6.173-1.991L11.63 0 9.304 3.872l2.724 4.674zM6.837 24l4.85-4.053h-.013c-2.219 0-4.017-1.784-4.017-3.984 0-.794.235-1.534.64-2.156l2.865-4.976-2.381-4.087L2 16.034 6.83 24h.007zM13.737 19.382h-.001L8.222 24h8.182l4.148-6.769-6.815 2.151z";
  const LOGO_SVG=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill-rule="evenodd" d="${LOGO_PATH_D}"/></svg>`;

  function buildLogo(){
    const data=new SVGLoader().parse(LOGO_SVG);
    const shapes=[];
    for(const path of data.paths){
      let s;
      if(typeof SVGLoader.createShapes==='function') s=SVGLoader.createShapes(path);
      else s=path.toShapes(true);
      for(const sh of s) shapes.push(sh);
    }

    const extrude={
      depth:CFG.EXTRUDE_DEPTH, bevelEnabled:true,
      bevelThickness:CFG.BEVEL_THICK, bevelSize:CFG.BEVEL_SIZE,
      bevelSegments:3, curveSegments:32, steps:1
    };

    const geoms=shapes.map(sh=>{
      const g=new THREE.ExtrudeGeometry(sh,extrude);
      g.rotateX(Math.PI);
      return g;
    });

    const combined=new THREE.Box3();
    geoms.forEach(g=>{ g.computeBoundingBox(); combined.union(g.boundingBox); });
    const center=new THREE.Vector3(); combined.getCenter(center);
    const size=new THREE.Vector3(); combined.getSize(size);
    const scale=CFG.TARGET_HEIGHT/size.y;

    const corners=[
      new THREE.Vector3( 15, 11,  5),
      new THREE.Vector3(-16,-11,  5),
      new THREE.Vector3( 16,-12, -5),
      new THREE.Vector3(-15, 12, -4),
    ];

    geoms.forEach((g,i)=>{
      g.translate(-center.x,-center.y,-center.z);
      g.scale(scale,scale,scale);
      g.computeBoundingBox();

      const mesh=new THREE.Mesh(g,material);
      logoGroup.add(mesh);
      solidMeshes.push(mesh);
      mesh.layers.enable(1);

      const gc=new THREE.Vector3(); g.boundingBox.getCenter(gc);
      const outDir=gc.clone();
      if(outDir.lengthSq()<1e-6) outDir.set(rand(-1,1),rand(-1,1),rand(-1,1));
      outDir.normalize();

      const axis=new THREE.Vector3(rand(-1,1),rand(-1,1),rand(-1,1)).normalize();
      const angle=rand(Math.PI*1.5,Math.PI*3)*(Math.random()<0.5?-1:1);

      pieces.push({
        mesh,
        home:new THREE.Vector3(0,0,0),
        center:gc.clone(),
        expandCur:new THREE.Vector2(),
        introStart:corners[i%corners.length].clone(),
        introAxis:axis,
        introAngle:angle,
        introQuat:new THREE.Quaternion().setFromAxisAngle(axis,angle),
        outDir,
      });

      mesh.position.copy(pieces[pieces.length-1].introStart);
      mesh.quaternion.copy(pieces[pieces.length-1].introQuat);
    });

    buildShatter(shapes, center, scale, extrude);
  }

  /* ---------- shatter mesh ---------- */
  function buildShatter(shapes, center, scale, extrude){
    const RES=256;
    const _cv=document.createElement('canvas'); _cv.width=_cv.height=RES;
    const _ctx=_cv.getContext('2d');
    _ctx.fillStyle='#fff'; _ctx.scale(RES/24,RES/24);
    _ctx.fill(new Path2D(LOGO_PATH_D),'evenodd');
    const _img=_ctx.getImageData(0,0,RES,RES).data;
    const inside=(sx,sy)=>{
      const px=Math.floor(sx*RES/24), py=Math.floor(sy*RES/24);
      if(px<0||py<0||px>=RES||py>=RES) return false;
      return _img[(py*RES+px)*4+3]>128;
    };

    const baseGeoms=shapes.map(sh=>{
      const g=new THREE.ExtrudeGeometry(sh,extrude);
      g.rotateX(Math.PI); g.translate(-center.x,-center.y,-center.z); g.scale(scale,scale,scale);
      g.computeBoundingBox(); return g;
    });
    const bb=new THREE.Box3(); baseGeoms.forEach(g=>bb.union(g.boundingBox));
    baseGeoms.forEach(g=>g.dispose());
    const zBack=bb.min.z, zFront=bb.max.z, depthZ=zFront-zBack;

    const CELL=0.24, NZ=2, cellZ=depthZ/NZ;
    const _dir=new THREE.Vector3();
    const boxes=[];
    for(let ly=bb.min.y; ly<bb.max.y; ly+=CELL){
      for(let lx=bb.min.x; lx<bb.max.x; lx+=CELL){
        const ccx=lx+CELL*0.5, ccy=ly+CELL*0.5;
        const sx=ccx/scale+center.x, sy=-(ccy/scale+center.y);
        if(!inside(sx,sy)) continue;
        for(let zi=0; zi<NZ; zi++){
          const ccz=zBack+cellZ*(zi+0.5);
          const bg=new THREE.BoxGeometry(CELL*0.95, CELL*0.95, cellZ*0.9);
          bg.translate(ccx,ccy,ccz);
          _dir.set(ccx,ccy,ccz);
          if(_dir.lengthSq()<1e-6) _dir.set(rand(-1,1),rand(-1,1),rand(-1,1));
          _dir.normalize();
          _dir.x+=rand(-0.2,0.2); _dir.y+=rand(-0.2,0.2); _dir.z+=rand(-0.05,0.45);
          _dir.normalize();
          const ax=new THREE.Vector3(rand(-1,1),rand(-1,1),rand(-1,1)).normalize();
          const rnd=Math.random();
          const vc=bg.attributes.position.count;
          const aC=new Float32Array(vc*3),aD=new Float32Array(vc*3),aA=new Float32Array(vc*3),aR=new Float32Array(vc);
          for(let v=0;v<vc;v++){
            aC[v*3]=ccx; aC[v*3+1]=ccy; aC[v*3+2]=ccz;
            aD[v*3]=_dir.x; aD[v*3+1]=_dir.y; aD[v*3+2]=_dir.z;
            aA[v*3]=ax.x; aA[v*3+1]=ax.y; aA[v*3+2]=ax.z;
            aR[v]=rnd;
          }
          bg.setAttribute('aCentroid',new THREE.BufferAttribute(aC,3));
          bg.setAttribute('aDir',new THREE.BufferAttribute(aD,3));
          bg.setAttribute('aAxis',new THREE.BufferAttribute(aA,3));
          bg.setAttribute('aRand',new THREE.BufferAttribute(aR,1));
          boxes.push(bg);
        }
      }
    }
    if(!boxes.length) return;
    const sgeo=mergeGeometries(boxes,false);
    boxes.forEach(b=>b.dispose());

    shatterUniform={value:0};
    shatterMat=new THREE.MeshPhysicalMaterial({
      color:0x0a0c12, metalness:0.95, roughness:0.2,
      clearcoat:1.0, clearcoatRoughness:0.2, envMapIntensity:1.6,
      emissive:0xff6a28, emissiveIntensity:0.0,
      side:THREE.DoubleSide
    });
    shatterMat.onBeforeCompile=(shader)=>{
      shader.uniforms.uProgress=shatterUniform;
      shader.vertexShader=shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 aCentroid; attribute vec3 aDir; attribute vec3 aAxis; attribute float aRand;
          uniform float uProgress;
          vec3 rotAxis(vec3 v, vec3 axis, float a){
            axis=normalize(axis); float c=cos(a), s=sin(a);
            return v*c + cross(axis,v)*s + axis*dot(axis,v)*(1.0-c);
          }`)
        .replace('#include <beginnormal_vertex>', `
          float fp=clamp((uProgress-aRand*0.22)/(1.0-aRand*0.22),0.0,1.0);
          float fe=1.0-pow(1.0-fp,2.6);
          float fang=fe*(1.6+aRand*4.2);
          vec3 objectNormal=rotAxis(normalize(normal),aAxis,fang);
          #ifdef USE_TANGENT
            vec3 objectTangent=vec3(tangent.xyz);
          #endif`)
        .replace('#include <begin_vertex>', `
          vec3 rel=position-aCentroid;
          rel=rotAxis(rel,aAxis,fang);
          vec3 transformed=aCentroid+rel+aDir*fe*(3.4+aRand*5.4);`);
    };
    shatterMesh=new THREE.Mesh(sgeo,shatterMat);
    shatterMesh.visible=false;
    shatterMesh.frustumCulled=false;
    shatterMesh.layers.enable(1);
    logoGroup.add(shatterMesh);
  }

  /* ---------- environment (PMREM from canvas gradient) ---------- */
  function buildEnv(){
    const c=document.createElement('canvas'); c.width=1024; c.height=512;
    const ctx=c.getContext('2d');
    const g=ctx.createLinearGradient(0,0,0,512);
    g.addColorStop(0,'#10151f'); g.addColorStop(0.5,'#080b12'); g.addColorStop(1,'#030406');
    ctx.fillStyle=g; ctx.fillRect(0,0,1024,512);
    const hb=ctx.createLinearGradient(0,255,0,360);
    hb.addColorStop(0,'rgba(205,216,236,0)');
    hb.addColorStop(0.5,'rgba(214,224,242,0.32)');
    hb.addColorStop(1,'rgba(205,216,236,0)');
    ctx.fillStyle=hb; ctx.fillRect(0,255,1024,105);
    let rg=ctx.createRadialGradient(370,300,40,370,300,340);
    rg.addColorStop(0,'rgba(255,150,70,0.62)'); rg.addColorStop(1,'rgba(255,150,70,0)');
    ctx.fillStyle=rg; ctx.fillRect(0,0,1024,512);
    let cg=ctx.createRadialGradient(775,150,40,775,150,360);
    cg.addColorStop(0,'rgba(95,140,255,0.42)'); cg.addColorStop(1,'rgba(95,140,255,0)');
    ctx.fillStyle=cg; ctx.fillRect(0,0,1024,512);

    const img=ctx.getImageData(0,0,1024,512); const dd=img.data;
    for(let i=0;i<dd.length;i+=4){
      const n=(Math.random()-0.5)*9;
      dd[i]+=n; dd[i+1]+=n; dd[i+2]+=n;
    }
    ctx.putImageData(img,0,0);

    const tex=new THREE.CanvasTexture(c);
    tex.mapping=THREE.EquirectangularReflectionMapping;
    tex.colorSpace=THREE.SRGBColorSpace;
    const pmrem=new THREE.PMREMGenerator(renderer);
    const rt=pmrem.fromEquirectangular(tex);
    scene.environment=rt.texture;
    tex.dispose(); pmrem.dispose();
  }

  /* ---------- ambient atmosphere: drifting glow orbs ---------- */
  function softSprite(rgb){
    const s=128, cv=document.createElement('canvas'); cv.width=cv.height=s;
    const x=cv.getContext('2d');
    const g=x.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);
    g.addColorStop(0,`rgba(${rgb},0.9)`);
    g.addColorStop(0.4,`rgba(${rgb},0.32)`);
    g.addColorStop(1,`rgba(${rgb},0)`);
    x.fillStyle=g; x.fillRect(0,0,s,s);
    const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; return t;
  }
  function buildAmbience(){
    ambGroup=new THREE.Group(); scene.add(ambGroup);
    const warmTex=softSprite('255,150,80');
    const coolTex=softSprite('120,160,255');
    const defs=[
      {tex:warmTex, n:3, sMin:7, sMax:12, op:0.10},
      {tex:coolTex, n:3, sMin:6, sMax:11, op:0.085},
    ];
    for(const def of defs){
      for(let i=0;i<def.n;i++){
        const mat=new THREE.SpriteMaterial({ map:def.tex, transparent:true, opacity:def.op,
          blending:THREE.AdditiveBlending, depthWrite:false });
        const sp=new THREE.Sprite(mat);
        const sc=rand(def.sMin,def.sMax); sp.scale.set(sc,sc,1);
        const base=new THREE.Vector3(rand(-9,9),rand(-6,6),rand(-16,-7));
        sp.position.copy(base);
        ambGroup.add(sp);
        orbs.push({ sp, base, op:def.op,
          ax:rand(1.2,3.0), ay:rand(1.0,2.4),
          sx:rand(0.04,0.10)*(Math.random()<0.5?-1:1),
          sy:rand(0.03,0.08)*(Math.random()<0.5?-1:1),
          ph:rand(0,Math.PI*2), tw:rand(0.2,0.5) });
      }
    }
  }

  /* ---------- 3D rotating particles ---------- */
  const _pm=new THREE.Matrix4(), _pq=new THREE.Quaternion(), _pp=new THREE.Vector3(), _ps=new THREE.Vector3();
  function buildParticles(){
    const N=80;
    const geo=new THREE.IcosahedronGeometry(1,0);
    const mat=new THREE.MeshStandardMaterial({
      color:0x7184a6, metalness:0.4, roughness:0.55,
      emissive:0x1d2c49, emissiveIntensity:0.3
    });
    particles=new THREE.InstancedMesh(geo,mat,N);
    particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for(let i=0;i<N;i++){
      particleData.push({
        base:new THREE.Vector3(rand(-13,13),rand(-9,9),rand(-15,2)),
        axis:new THREE.Vector3(rand(-1,1),rand(-1,1),rand(-1,1)).normalize(),
        spd:rand(0.2,0.8)*(Math.random()<0.5?-1:1),
        phase:rand(0,Math.PI*2),
        scl:rand(0.05,0.13),
        drift:rand(0.3,0.7)
      });
    }
    scene.add(particles);
  }
  function updateParticles(){
    if(!particles) return;
    for(let i=0;i<particleData.length;i++){
      const d=particleData[i];
      _pq.setFromAxisAngle(d.axis, elapsed*d.spd*motion + d.phase);
      _pp.set(
        d.base.x+Math.sin(elapsed*0.2*d.drift+d.phase)*0.6*motion,
        d.base.y+Math.cos(elapsed*0.16*d.drift+d.phase)*0.5*motion,
        d.base.z+Math.sin(elapsed*0.13*d.drift+d.phase)*0.4*motion
      );
      _ps.setScalar(d.scl);
      _pm.compose(_pp,_pq,_ps);
      particles.setMatrixAt(i,_pm);
    }
    particles.instanceMatrix.needsUpdate=true;
  }

  /* ---------- shockwave ring (explosion) ---------- */
  function buildShockwave(){
    const s=256, cv=document.createElement('canvas'); cv.width=cv.height=s;
    const x=cv.getContext('2d');
    const g=x.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);
    g.addColorStop(0.00,'rgba(255,222,188,0)');
    g.addColorStop(0.70,'rgba(255,222,188,0)');
    g.addColorStop(0.84,'rgba(255,236,212,0.7)');
    g.addColorStop(0.93,'rgba(255,178,112,0.14)');
    g.addColorStop(1.00,'rgba(255,150,80,0)');
    x.fillStyle=g; x.fillRect(0,0,s,s);
    const tex=new THREE.CanvasTexture(cv); tex.colorSpace=THREE.SRGBColorSpace;
    const mat=new THREE.MeshBasicMaterial({ map:tex, transparent:true, opacity:0,
      blending:THREE.AdditiveBlending, depthWrite:false, depthTest:false, side:THREE.DoubleSide });
    shockwave=new THREE.Mesh(new THREE.PlaneGeometry(2,2), mat);
    shockwave.scale.setScalar(0.1);
    logoGroup.add(shockwave);
  }

  /* ---------- spark burst (explosion) ---------- */
  function buildSparks(){
    const tex=softSprite('255,205,150');
    for(let i=0;i<26;i++){
      const mat=new THREE.SpriteMaterial({ map:tex, transparent:true, opacity:0,
        blending:THREE.AdditiveBlending, depthWrite:false, depthTest:false });
      const sp=new THREE.Sprite(mat); sp.scale.setScalar(0.001); scene.add(sp);
      sparks.push({ sp, vel:new THREE.Vector3(), life:0, max:1 });
    }
  }
  function fireSparks(){
    for(const s of sparks){
      const dir=new THREE.Vector3(rand(-1,1),rand(-1,1),rand(-0.5,0.7)).normalize();
      s.vel.copy(dir).multiplyScalar(rand(6,13));
      s.life=s.max=rand(0.5,0.95);
      s.sp.position.set(rand(-0.3,0.3),rand(-0.3,0.3),rand(-0.3,0.3));
      s.sp.material.opacity=1;
    }
  }
  function updateSparks(dt){
    const drag=Math.pow(0.2,dt);
    for(const s of sparks){
      if(s.life>0){
        s.life-=dt;
        s.sp.position.addScaledVector(s.vel,dt);
        s.vel.multiplyScalar(drag);
        const f=Math.max(0,s.life/s.max);
        s.sp.material.opacity=f;
        s.sp.scale.setScalar(0.05+0.4*f);
        if(s.life<=0) s.sp.material.opacity=0;
      }
    }
  }

  /* ---------- ambience update ---------- */
  function updateAmbience(){
    for(const o of orbs){
      o.sp.position.set(
        o.base.x+Math.sin(elapsed*o.sx+o.ph)*o.ax,
        o.base.y+Math.cos(elapsed*o.sy+o.ph)*o.ay,
        o.base.z
      );
      o.sp.material.opacity=o.op*(0.7+0.3*Math.sin(elapsed*o.tw+o.ph));
    }
    if(ambGroup){ ambGroup.position.x=pointerN.x*0.2; ambGroup.position.y=pointerN.y*0.15; }
  }

  /* ---------- explosion ---------- */
  function startExplosion(){
    setState('EXPLODING');
    tiltGroup.scale.setScalar(1);
    logoGroup.scale.setScalar(1);
    hoverGlow=0;
    transitionStarted=false;
    for(const p of pieces) p.mesh.visible=false;
    if(shatterMesh){ shatterMesh.visible=true; shatterMat.emissiveIntensity=0.0; }
    if(shatterUniform) shatterUniform.value=0;
    warmLight.position.set(0,0,2.5);
    fireSparks();
    if(shockwave){ shockwave.position.set(0,0,0); shockwave.scale.setScalar(0.5); shockwave.material.opacity=0.7; }
    camKick=1.0;
    flashEl.style.transition='opacity 0.06s ease-out'; flashEl.style.opacity='0.4';
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      flashEl.style.transition='opacity 0.75s ease-out'; flashEl.style.opacity='0';
    }));
    warmLight.intensity=175; warmLight.color.setHSL(0.07,0.78,0.58);
    bloom.strength=1.4;
  }

  // Hand off to the app's boot screen (real model load). The scene only dims itself here.
  function beginTransition(){
    sceneWrap.classList.add('dim');
    window.LFMApp?.beginBoot();
  }

  /* ---------- reset the scene visuals to the intro + restart the loop ---------- */
  function sceneReplay(){
    setState('INTRO'); charge=0; floatLevel=0; hoverGlow=0; camKick=0;
    isHolding=false; autoBlast=false; transitionStarted=false;
    material.opacity=1; material.emissive.copy(EMISSIVE_BASE); material.emissiveIntensity=CFG.BASE_EMISSIVE;
    logoGroup.scale.setScalar(1);
    for(const p of pieces){ p.mesh.position.copy(p.introStart); p.mesh.quaternion.copy(p.introQuat); p.expandCur.set(0,0); p.mesh.visible=true; }
    if(shatterMesh) shatterMesh.visible=false;
    if(shatterUniform) shatterUniform.value=0;
    if(shockwave) shockwave.material.opacity=0;
    for(const s of sparks){ s.life=0; s.sp.material.opacity=0; }
    warmLight.intensity=CFG.WARM_BASE; warmLight.color.setHSL(0.06,1,0.5);
    bloom.strength=CFG.BLOOM_BASE;
    tiltGroup.scale.setScalar(1);
    sceneWrap.classList.remove('dim');
    sceneActive=true;
    if(rafId===null){ clock.getDelta(); animate(); }
  }

  // Park the render loop entirely so the WebGPU model gets the whole GPU during inference.
  function stopScene(){ sceneActive=false; if(rafId){ cancelAnimationFrame(rafId); rafId=null; } }

  /* ---------- per-piece placement ---------- */
  function applyFloat(p){
    p.mesh.position.set(p.expandCur.x, p.expandCur.y, 0);
    p.mesh.quaternion.identity();
  }

  /* ---------- cursor "expand" ---------- */
  const _eRay=new THREE.Ray();
  const _ePlane=new THREE.Plane(new THREE.Vector3(0,0,1),0);
  const _eHit=new THREE.Vector3();
  const _eInv=new THREE.Matrix4();
  function updateExpand(dt){
    let haveHit=false, hx=0, hy=0;
    if(state==='IDLE'){
      _eInv.copy(logoGroup.matrixWorld).invert();
      _eRay.copy(raycaster.ray).applyMatrix4(_eInv);
      if(_eRay.intersectPlane(_ePlane,_eHit)){ hx=_eHit.x; hy=_eHit.y; haveHit=true; }
    }
    const k=Math.min(1,dt*6);
    pieces.forEach(p=>{
      let tx=0, ty=0;
      if(haveHit){
        const ox=p.center.x-hx, oy=p.center.y-hy;
        const d=Math.hypot(ox,oy)+0.001;
        const push=CFG.EXPAND_STRENGTH*Math.exp(-d/CFG.EXPAND_RANGE);
        tx=(ox/d)*push; ty=(oy/d)*push;
      }
      p.expandCur.x+=(tx-p.expandCur.x)*k;
      p.expandCur.y+=(ty-p.expandCur.y)*k;
    });
  }

  const _chgEuler=new THREE.Euler();
  function applyCharge(){
    const c=charge, c2=c*c;
    pieces.forEach((p,i)=>{
      const rA=0.11*c2;
      const rx=(Math.sin(elapsed*48+i)*0.6+(Math.random()*2-1)*0.4)*rA;
      const ry=(Math.cos(elapsed*53+i)*0.6+(Math.random()*2-1)*0.4)*rA;
      const rz=(Math.sin(elapsed*44+i)*0.6+(Math.random()*2-1)*0.4)*rA;
      const pull=-0.12*c;
      p.mesh.position.set(
        p.expandCur.x + rx + p.outDir.x*pull,
        p.expandCur.y + ry + p.outDir.y*pull,
        rz + p.outDir.z*pull
      );
      const j=0.08*c;
      _chgEuler.set(Math.sin(elapsed*46+i)*j, Math.cos(elapsed*43+i)*j, Math.sin(elapsed*49+i)*j);
      p.mesh.quaternion.setFromEuler(_chgEuler);
    });
    material.emissiveIntensity=CFG.BASE_EMISSIVE+c2*CFG.CHARGE_EMISSIVE;
    material.emissive.copy(EMISSIVE_BASE).lerp(EMISSIVE_HOT,c2);
    warmLight.intensity=CFG.WARM_BASE+c*110;
    warmLight.color.setHSL(lerp(0.06,0.12,c),lerp(1,0.6,c),lerp(0.5,0.78,c));
    bloom.strength=CFG.BLOOM_BASE+c*0.55;
    tiltGroup.scale.setScalar(1-0.03*c);
  }

  function toBase(dt,k){
    const emiTarget=CFG.BASE_EMISSIVE+hoverGlow*CFG.HOVER_EMISSIVE;
    const warmTarget=CFG.WARM_BASE+hoverGlow*14;
    const bloomTarget=CFG.BLOOM_BASE+hoverGlow*0.06;
    warmLight.intensity=lerp(warmLight.intensity,warmTarget,dt*k);
    warmLight.color.setHSL(0.06,1,0.5);
    material.emissive.copy(EMISSIVE_BASE);
    material.emissiveIntensity=lerp(material.emissiveIntensity,emiTarget,dt*k);
    bloom.strength=lerp(bloom.strength,bloomTarget,dt*k);
  }

  /* ---------- hover detection ---------- */
  const _ndc=new THREE.Vector2();
  function updateHover(dt){
    let over=false;
    if(state==='INTRO'||state==='IDLE'){
      over=raycaster.intersectObjects(solidMeshes,false).length>0;
    }
    const target=over?1:0;
    hoverGlow+=(target-hoverGlow)*Math.min(1,dt*8);
  }

  /* ---------- main update ---------- */
  function update(dt){
    if(state!=='INTRO') floatLevel=Math.min(1,floatLevel+dt/0.7);
    if(state==='IDLE' && (isHolding||autoBlast)) setState('CHARGING');
    _ndc.set(pointerN.x,pointerN.y);
    raycaster.setFromCamera(_ndc,camera);
    updateHover(dt);
    updateExpand(dt);

    if(state==='INTRO'){
      let done=true;
      pieces.forEach((p,i)=>{
        const local=clamp((stateTime-CFG.INTRO_DELAY-i*CFG.INTRO_STAGGER)/CFG.INTRO_DUR,0,1);
        if(local<1) done=false;
        const e=easeOutExpo(local);
        p.mesh.position.lerpVectors(p.introStart,p.home,e);
        p.mesh.quaternion.setFromAxisAngle(p.introAxis,p.introAngle*(1-e));
      });
      toBase(dt,4);
      if(done) setState('IDLE');
    } else if(state==='IDLE'){
      pieces.forEach(applyFloat);
      toBase(dt,4);
    } else if(state==='CHARGING'){
      const rate=autoBlast?1/0.6:1/1.0;
      if(isHolding||autoBlast) charge=Math.min(1,charge+dt*rate);
      else charge=Math.max(0,charge-dt/0.35);
      applyCharge();
      if(charge>=1) startExplosion();
      else if(charge<=0 && !isHolding && !autoBlast){ tiltGroup.scale.setScalar(1); setState('IDLE'); }
    } else if(state==='EXPLODING'){
      const t=stateTime;
      if(shatterUniform) shatterUniform.value=Math.min(1,t/1.2);
      if(shatterMat) shatterMat.emissiveIntensity=Math.max(0,0.55*Math.exp(-t*3.2));
      warmLight.intensity=lerp(warmLight.intensity,CFG.WARM_BASE,dt*2.0);
      bloom.strength=lerp(bloom.strength,CFG.BLOOM_BASE,dt*1.7);
      if(shockwave){
        const st=clamp(t/0.55,0,1), e=1-(1-st)*(1-st);
        shockwave.scale.setScalar(0.5+e*5.5);
        shockwave.material.opacity=0.7*(1-st)*(1-st);
      }
      if(t>0.32 && !transitionStarted){ transitionStarted=true; beginTransition(); }
      if(t>1.5) setState('DONE');
    } else if(state==='DONE'){
      toBase(dt,4);
      if(sceneActive) stopScene(); // intro finished → park the loop, hand the GPU to inference
    }

    if(state!=='EXPLODING' && state!=='DONE'){
      warmLight.position.set(
        Math.cos(elapsed*0.6)*CFG.ORBIT_R,
        Math.sin(elapsed*0.45)*2.2+1.0,
        Math.sin(elapsed*0.6)*CFG.ORBIT_R+1.5
      );
    }

    camKick=lerp(camKick,0,dt*4);
    const tpx=pointerN.x*0.22, tpy=pointerN.y*0.16;
    camera.position.x+=(tpx-camera.position.x)*0.05 + (Math.random()*2-1)*camKick*0.018;
    camera.position.y+=(tpy-camera.position.y)*0.05 + (Math.random()*2-1)*camKick*0.018;
    camera.position.z=CFG.CAM_Z;
    camera.lookAt(0,0,0);

    logoGroup.position.set(Math.sin(elapsed*0.35)*0.02*floatLevel, Math.sin(elapsed*0.5)*0.035*floatLevel, 0);
    logoGroup.rotation.set(0,0,0);
    logoGroup.scale.setScalar(1);

    const shimmy=Math.sin(elapsed*CFG.SHIMMY_SPEED)*CFG.SHIMMY_AMP*motion
                +Math.sin(elapsed*CFG.SHIMMY_SPEED*0.53+1.3)*CFG.SHIMMY_AMP*0.4*motion;
    tiltGroup.rotation.x=CFG.BASE_ROT.x+Math.sin(elapsed*0.34)*0.035*motion-pointerN.y*0.035*motion;
    tiltGroup.rotation.y=CFG.BASE_ROT.y+shimmy+pointerN.x*0.045*motion;
    tiltGroup.rotation.z=CFG.BASE_ROT.z+Math.sin(elapsed*CFG.SHIMMY_SPEED*0.7+0.6)*CFG.SHIMMY_AMP*0.28*motion;

    updateAmbience();
    updateParticles();
    updateSparks(dt);
  }

  /* ---------- resize ---------- */
  function onResize(){
    const w=window.innerWidth, h=window.innerHeight;
    const dpr=Math.min(window.devicePixelRatio,2);
    camera.aspect=w/h; camera.updateProjectionMatrix();
    renderer.setPixelRatio(dpr);
    renderer.setSize(w,h);
    composer.setPixelRatio(dpr);
    composer.setSize(w,h);
  }

  /* ---------- loop ---------- */
  function animate(){
    if(!sceneActive){ rafId=null; return; }
    rafId=requestAnimationFrame(animate);
    const dt=Math.min(clock.getDelta(),0.05);
    elapsed+=dt; stateTime+=dt;
    update(dt);
    composer.render();
    document.body.classList.add('ready');
  }
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){ if(rafId){ cancelAnimationFrame(rafId); rafId=null; } }
    else if(rafId===null && sceneActive){ clock.getDelta(); animate(); }
  });

  /* ---------- init ---------- */
  function init(){
    const test=document.createElement('canvas');
    if(!(test.getContext('webgl2')||test.getContext('webgl'))){
      // No WebGL → degrade gracefully: no 3D, but the hero + LOAD MODEL still work.
      document.body.classList.add('ready');
      return;
    }

    renderer=new THREE.WebGLRenderer({ canvas, antialias:false, alpha:true, powerPreference:'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    renderer.setSize(window.innerWidth,window.innerHeight);
    renderer.setClearColor(0x000000,0);
    renderer.toneMapping=THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure=CFG.EXPOSURE;
    renderer.outputColorSpace=THREE.SRGBColorSpace;

    scene=new THREE.Scene();
    camera=new THREE.PerspectiveCamera(CFG.FOV,window.innerWidth/window.innerHeight,0.1,200);
    camera.position.set(0,0,CFG.CAM_Z);
    clock=new THREE.Clock();

    tiltGroup=new THREE.Group();
    logoGroup=new THREE.Group();
    tiltGroup.add(logoGroup);
    tiltGroup.rotation.set(CFG.BASE_ROT.x,CFG.BASE_ROT.y,CFG.BASE_ROT.z);
    scene.add(tiltGroup);

    material=new THREE.MeshPhysicalMaterial({
      color:0x0a0c12, metalness:0.9, roughness:0.4,
      clearcoat:0.9, clearcoatRoughness:0.42, envMapIntensity:1.3,
      emissive:0xff5a18, emissiveIntensity:CFG.BASE_EMISSIVE,
      side:THREE.FrontSide, transparent:true
    });

    raycaster=new THREE.Raycaster();

    buildEnv();
    buildLogo();
    buildAmbience();
    buildParticles();
    buildShockwave();
    buildSparks();

    const hemi=new THREE.HemisphereLight(0x38445e,0x070a12,0.45); scene.add(hemi);
    const keyLight=new THREE.DirectionalLight(0x9ab4ff,1.4); keyLight.position.set(-7,8,6); scene.add(keyLight);
    const rimLight=new THREE.DirectionalLight(0xffcaa0,1.9); rimLight.position.set(5,3,-7); scene.add(rimLight);
    const fillLight=new THREE.DirectionalLight(0x5a78c8,0.45); fillLight.position.set(4,-4,5); scene.add(fillLight);
    warmLight=new THREE.PointLight(0xff7a30,CFG.WARM_BASE,0,2); warmLight.layers.set(1); scene.add(warmLight);

    const dpr=Math.min(window.devicePixelRatio,2);
    const rt=new THREE.WebGLRenderTarget(window.innerWidth,window.innerHeight,{
      type:THREE.HalfFloatType, samples:4
    });
    composer=new EffectComposer(renderer,rt);
    composer.addPass(new RenderPass(scene,camera));
    bloom=new UnrealBloomPass(new THREE.Vector2(window.innerWidth,window.innerHeight),CFG.BLOOM_BASE,CFG.BLOOM_RADIUS,CFG.BLOOM_THRESHOLD);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    composer.setPixelRatio(dpr);
    composer.setSize(window.innerWidth,window.innerHeight);

    window.addEventListener('resize',onResize);
    try{ renderer.compile(scene,camera); }catch(e){/* pre-warm is best-effort */}
    animate();

    // Publish the scene API now that everything is live.
    window.LFMScene = { triggerBlast, replay: sceneReplay, stop: stopScene };
  }

  function triggerBlast(){
    if(!canLoad()) return;
    if(state==='IDLE'||state==='INTRO'){ autoBlast=true; if(state==='IDLE') setState('CHARGING'); }
  }

  /* ---------- interaction wiring ---------- */
  // HOLD anywhere over the canvas → charge → BLAST (only if the device can run the model)
  canvas.addEventListener('pointerdown',()=>{ if(!canLoad()) return; if(state!=='EXPLODING'&&state!=='DONE') isHolding=true; });
  window.addEventListener('pointerup',()=>{ isHolding=false; });
  canvas.addEventListener('pointercancel',()=>{ isHolding=false; });
  window.addEventListener('pointermove',e=>{
    pointerN.x=(e.clientX/window.innerWidth)*2-1;
    pointerN.y=-((e.clientY/window.innerHeight)*2-1);
  });
  // keyboard fallback for the blast (hold Space) — but not while typing in the chat composer
  window.addEventListener('keydown',e=>{
    if(e.code==='Space' && canLoad() && state!=='EXPLODING' && state!=='DONE'
       && document.activeElement?.tagName!=='TEXTAREA' && document.activeElement?.tagName!=='INPUT'){
      e.preventDefault(); isHolding=true;
    }
  });
  window.addEventListener('keyup',e=>{ if(e.code==='Space') isHolding=false; });

  // boot — degrade gracefully on any init failure (the app's hero/CTA still work)
  try{ init(); }catch(err){ console.error(err); document.body.classList.add('ready'); }
  
