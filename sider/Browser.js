const { spawn } = require("child_process");
const EventEmitter = require("events");

const _ = require("lodash");

const CDP = require("./CDP");
const Page = require("./Page");
const ServiceWorker = require("./ServiceWorker");
const SiderError = require("./Error");

const PAGE_OPEN_AND_CLOSE_REASON_USER = "user";
const PAGE_OPEN_AND_CLOSE_REASON_PROGRAM = "program";

const printDebugLog = typeof process.env.SIDER_DEBUG === "string" &&
	process.env.SIDER_DEBUG.includes("browser");

async function getWSEndpoint(browserProcess) {
	return new Promise(resolve => {
		const devToolsWsEndpointRegExp = /DevTools listening on (ws:\/\/.*)\r?\n/;

		let output = "";

		const handleBrowserProcessStdErrOnData = chunk => {
			output += chunk.toString();

			const match = output.match(devToolsWsEndpointRegExp);
			if (match) {
				const url = match[1];

				browserProcess.stderr.off("data", handleBrowserProcessStdErrOnData);
				browserProcess.off("close", handleBrowserProcessOnClose);

				return resolve(url);
			}
		};

		const handleBrowserProcessOnClose = () => {
			browserProcess.stderr.off("data", handleBrowserProcessStdErrOnData);
			browserProcess.off("close", handleBrowserProcessOnClose);

			return resolve(null);
		};

		browserProcess.stderr.on("data", handleBrowserProcessStdErrOnData);
		browserProcess.on("close", handleBrowserProcessOnClose);
	});
}

module.exports = class Browser extends EventEmitter {
	constructor(options = {}) {
		super();

		this.options = options;
	}

	async launch(options) {
		options.args.set("--remote-debugging-port", 0);

		if (printDebugLog) console.log(`Sider browser: ${options.executablePath}\n${options.args.toArray().join("\n")}`);

		this.browserProcess = spawn(options.executablePath, options.args.toArray(), {
			// env: process.env
		});

		this.browserProcess.on("close", this.processClosed.bind(this));

		this.browserProcess.on("disconnect", () => {
		});

		this.browserProcess.on("exit", (code, signal) => {
		});

		this.browserProcess.on("error", error => {
			throw error;
		});

		this.wsEndpoint = await getWSEndpoint(this.browserProcess);
	}

	async connect(wsEndpoint) {
		this.wsEndpoint = wsEndpoint;
	}

	async initialize() {
		this.pages = new Map();
		this.serviceWorkers = new Map();

		this.cdp = new CDP(this, this.wsEndpoint);
		await this.cdp.initialize();

		this.cdp.on("closed", this.processClosed.bind(this));

		this.programOpenPage = 1;
		this.programClosePage = 0;

		this.cdp.rootSession.on("targetCreated", async target => {
			switch (target.targetInfo.type) {
				case "page": {
					const page = new Page(this, target);

					const targetId = page.target.targetId;
					if (this.pages.has(targetId)) throw new SiderError("Already has page", targetId);
					this.pages.set(targetId, page);

					await page.initialize();

					let reason = PAGE_OPEN_AND_CLOSE_REASON_USER;
					if (this.programOpenPage > 0) {
						this.programOpenPage--;

						reason = PAGE_OPEN_AND_CLOSE_REASON_PROGRAM;
					}

					page.addedToBrowser = true;
					if (!page.removedFromBrowser) this.emit("pageAdded", page, reason);

					break;
				}

				case "service_worker": {
					if (!this.optionHandleServiceWorkers) break;

					const serviceWorker = new ServiceWorker(this, target);

					const targetId = serviceWorker.target.targetId;
					if (this.serviceWorkers.has(targetId)) throw new SiderError("Already has serviceWorker", targetId);
					this.serviceWorkers.set(targetId, serviceWorker);

					await serviceWorker.initialize();

					this.emit("serviceWorkerAdded", serviceWorker);

					break;
				}

				default:
					break;
			}
		});

		this.cdp.rootSession.on("targetDestroyed", async target => {
			switch (target.targetInfo.type) {
				case "page": {
					const targetId = target.targetId;
					if (!this.pages.has(targetId)) throw new SiderError("No page", targetId);

					const page = this.pages.get(targetId);
					this.pages.delete(targetId);

					let reason = PAGE_OPEN_AND_CLOSE_REASON_USER;
					if (this.programClosePage > 0) {
						this.programClosePage--;

						reason = PAGE_OPEN_AND_CLOSE_REASON_PROGRAM;
					}

					page.removedFromBrowser = true;
					if (page.addedToBrowser) this.emit("pageRemoved", page, reason);

					break;
				}

				case "service_worker": {
					if (!this.optionHandleServiceWorkers) break;

					const targetId = target.targetId;
					if (!this.serviceWorkers.has(targetId)) throw new SiderError("No serviceWorker", targetId);

					const serviceWorker = this.serviceWorkers.get(targetId);
					this.serviceWorkers.delete(targetId);

					this.emit("serviceWorkerRemoved", serviceWorker);

					break;
				}

				default:
					break;
			}
		});

		// this.cdp.rootSession.on("targetCrashed", async target => {
		// 	switch (target.targetInfo.type) {
		// 		case "page": {
		// 			const targetId = target.targetId;
		// 			const page = this.pages.get(targetId);

		// 			break;
		// 		}

		// 		default:
		// 			break;
		// 	}
		// });

		// this.cdp.rootSession.on("targetInfoChanged", async target => {
		// 	switch (target.targetInfo.type) {
		// 		case "page": {
		// 			const targetId = target.targetId;
		// 			const page = this.pages.get(targetId);

		// 			break;
		// 		}

		// 		default:
		// 			break;
		// 	}
		// });

		// this.cdp.rootSession.on("attachedToTarget", async target => {
		// 	switch (target.targetInfo.type) {
		// 		case "page": {
		// 			const targetId = target.targetId;
		// 			const page = this.pages.get(targetId);

		// 			break;
		// 		}

		// 		default:
		// 			break;
		// 	}
		// });

		// this.cdp.rootSession.on("detachedFromTarget", async target => {
		// 	switch (target.targetInfo.type) {
		// 		case "page": {
		// 			const targetId = target.targetId;
		// 			const page = this.pages.get(targetId);

		// 			break;
		// 		}

		// 		default:
		// 			break;
		// 	}
		// });

		await this.cdp.rootSession.send("Target.setDiscoverTargets", { discover: true });
	}

	close() {
		if (this.browserProcess) {
			this.programClose = true;

			this.browserProcess.kill();
		} else {
			// TODO
		}
	}

	async openPage(url = "") {
		this.programOpenPage++;

		await this.cdp.rootSession.send("Target.createTarget", { url });
	}

	async closePage(page) {
		this.programClosePage++;

		await this.cdp.rootSession.send("Target.closeTarget", { targetId: page.target.targetId });
	}

	findPage(predicate) {
		return Array.from(this.pages.values()).find(predicate);
	}

	processClosed() {
		if (!this.closed) {
			this.browserProcess = null;
			this.wsEndpoint = null;

			this.closed = true;

			this.emit("closed", this.programClose ? PAGE_OPEN_AND_CLOSE_REASON_PROGRAM : PAGE_OPEN_AND_CLOSE_REASON_USER);
		}
	}

	// OPTIONS

	get optionEnableRuntime() {
		return _.get(this.options, "enableRuntime", true);
	}

	get optionHandleAuthRequests() {
		return _.get(this.options, "handleAuthRequests", true);
	}

	get optionHandleWebSocketRequests() {
		return _.get(this.options, "handleWebSocketRequests", false);
	}

	get optionHandleServiceWorkers() {
		return _.get(this.options, "handleServiceWorkers", false);
	}
};
