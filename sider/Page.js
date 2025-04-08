const EventEmitter = require("events");

const _ = require("lodash");

const SiderError = require("./Error");
const Frame = require("./Frame");
const Network = require("./Network");
const Input = require("./Input");
const { tick, tickToMilliseconds } = require("./tools/time");

const printDebugLog = typeof process.env.SIDER_DEBUG === "string" &&
	process.env.SIDER_DEBUG.includes("page");

module.exports = class Page extends EventEmitter {
	constructor(browser, target) {
		super();

		this.browser = browser;
		this.target = target;

		this.initialized = false;
		this.loading = false;
		this.loaded = false;

		this.frames = new Map();
		this.executionContexts = new Map();
		this.executionContextsByFrameId = new Map();

		this.frames.set(this.target.targetId, this.mainFrame = new Frame(this, this.target.targetId, null));

		this.target
			.on("attached", () => {
				this.cdp.on("Page.frameAttached", params => {
					this.frames.set(params.frameId, new Frame(this, params.frameId, params.parentFrameId));
				});

				this.cdp.on("Page.frameDetached", params => {
					this.frames.delete(params.frameId);
				});

				this.cdp.on("Page.frameNavigated", params => {
					const frame = this.frames.get(params.frame.id);
					// NOTE ожидается, что frame должна быть, т.е. Page.frameAttached вызывается до Page.frameNavigated
					// но иногда это не так
					if (frame) {
						_.assign(frame.info, params.frame);

						if (frame === this.mainFrame) {
							this.emit("navigated");
						}
					}
				});

				this.cdp.on("Page.frameStartedLoading", params => {
					if (params.frameId === this.mainFrame.id) {
						this.loading = true;
						this.loaded = false;

						this.emit("startedLoading");
					}
				});

				this.cdp.on("Page.frameStoppedLoading", params => {
				});

				this.cdp.on("Page.loadEventFired", params => {
					if (this.loading) {
						this.loading = false;
						this.loaded = true;

						this.emit("loaded");
					}
				});

				this.cdp.on("Runtime.executionContextCreated", params => {
					const context = params.context;

					if (context.auxData.isDefault) {
						const frameId = context.auxData.frameId;
						this.executionContextsByFrameId.set(frameId, context);
					}

					this.executionContexts.set(context.id, context);
				});

				this.cdp.on("Runtime.executionContextDestroyed", params => {
					const context = this.executionContexts.get(params.executionContextId);

					if (context.auxData.isDefault) {
						const frameId = context.auxData.frameId;
						this.executionContextsByFrameId.delete(frameId);
					}

					this.executionContexts.delete(context.id);
				});
			})
			.on("detached", () => {
			});

		this.network = new Network(this);
		this.input = new Input(this);
	}

	get cdp() {
		return this.target.cdpSession;
	}

	async initialize() {
		try {
			await this.browser.cdp.rootSession.send("Target.attachToTarget", { targetId: this.target.targetId, flatten: true });
		} catch (error) {
			if (this.removedFromBrowser) return;

			throw error;
		}

		await this.cdp.send("Page.enable");

		if (this.browser.optionEnableRuntime) await this.cdp.send("Runtime.enable");

		await this.network.initialize();
		await this.input.initialize();

		this.initialized = true;
	}

	async navigate(url) {
		await Promise.all([
			this.cdp.send("Page.navigate", { url })
			// this.waitForNavigation(url)
		]);
	}

	async reload() {
		await Promise.all([
			this.cdp.send("Page.reload")
			// this.waitForNavigation(this.mainFrame.url)
		]);
	}

	async waitForNavigation(url) {
		return new Promise((resolve, reject) => {
			const responseCallback = params => {
				if (params.responseErrorReason &&
					new URL(params.request.url).href === new URL(url).href) {
					unregisterCallbacks();

					return reject(new SiderError("Connection error", { responseErrorReason: params.responseErrorReason }));
				}
			};

			const navigatedCallback = params => {
				unregisterCallbacks();

				return resolve();
			};

			let originalResponseHandler;

			const registerCallbacks = () => {
				originalResponseHandler = this.network.responseHandler;
				this.network.responseHandler = responseCallback;
				this.on("navigated", navigatedCallback);
			};

			const unregisterCallbacks = () => {
				this.network.responseHandler = originalResponseHandler;
				this.off("navigated", navigatedCallback);
			};

			registerCallbacks();
		});
	}

	async close() {
		await this.cdp.send("Page.close");
	}

	getFrames(predicate) {
		const frames = Array.from(this.frames.values());

		return predicate ? frames.filter(predicate) : frames;
	}

	findFrame(predicate) {
		return Array.from(this.frames.values()).find(predicate);
	}

	async bringToFront() {
		await this.cdp.send("Page.bringToFront");
	}

	async evaluateOnNewDocument(source) {
		await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
	}

	async evaluateInFrame({ frame, func, returnByValue = true, args = [] }) {
		if (printDebugLog) console.log(`evaluateInFrame ${String(func)} ${args.map(String).join()}`);

		if (!frame) throw new SiderError("No frame");

		const executionContext = frame.executionContext;
		if (!executionContext) throw new SiderError("No executionContext");

		return this.evaluateInExecutionContext({
			executionContextId: executionContext.id,
			func,
			returnByValue,
			args
		});
	}

	async evaluateInExecutionContext({ executionContextId, func, returnByValue = true, args = [] }) {
		if (printDebugLog) console.log(`evaluateInExecutionContext ${executionContextId} ${String(func)} ${args.map(String).join()}`);

		if (!this.cdp) throw new SiderError("No cdpSession");

		const lastTick = tick();

		const result = await this.cdp.send("Runtime.callFunctionOn", {
			executionContextId,
			functionDeclaration: String(func),
			arguments: args.map(value => ({ value })),
			returnByValue,
			awaitPromise: true
		});

		this.lastEvaluateTimeInMilliseconds = tickToMilliseconds(tick(lastTick));

		if (printDebugLog) console.log(JSON.stringify(result, null, "\t"));

		if (result.result.subtype === "error") throw new SiderError(result.result.description);

		const value = returnByValue ? result.result.value : result.result;

		return value;
	}

	async getCookies() {
		const result = await this.cdp.send("Network.getCookies");

		return _.get(result, "cookies", []);
	}

	async getScreenshot() {
		const result = await this.cdp.send("Page.captureScreenshot");

		return result.data;
	}

	async getSnapshot() {
		const result = await this.cdp.send("Page.captureSnapshot");

		return result.data;
	}
};
