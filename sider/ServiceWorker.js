const EventEmitter = require("events");

const Network = require("./Network");

module.exports = class ServiceWorker extends EventEmitter {
	constructor(browser, target) {
		super();

		this.browser = browser;
		this.target = target;

		this.initialized = false;

		this.target
			.on("attached", () => {
			})
			.on("detached", () => {
			});

		this.network = new Network(this.browser, this);
	}

	get cdp() {
		return this.target.cdpSession;
	}

	async initialize() {
		await this.browser.cdp.rootSession.send("Target.attachToTarget", { targetId: this.target.targetId, flatten: true });

		await this.network.initialize();

		this.initialized = true;
	}
};
