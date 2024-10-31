const EventEmitter = require("events");

// const _ = require("lodash");

const SiderError = require("./Error");

module.exports = class Target extends EventEmitter {
	constructor(cdpRootSession, targetInfo) {
		super();

		this.targetInfo = targetInfo;
		this.cdpRootSession = cdpRootSession;
		this.cdpSession = null;
	}

	get targetId() {
		return this.targetInfo.targetId;
	}

	// handleInfoChanged(targetInfo) {
	// 	// пока не понял почему, но перед закрытием страницы ее type меняется, и логика вся портится
	// 	// пока не будем обновлять targetInfo.type
	// 	_.unset(targetInfo, "type");

	// 	_.assign(this.targetInfo, targetInfo);
	// }

	handleAttached(cdpSession) {
		if (this.cdpSession) throw new SiderError("cdpSession is not null");

		this.cdpSession = cdpSession;

		this.emit("attached");
	}

	handleDetached() {
		if (!this.cdpSession) throw new SiderError("cdpSession is null");

		this.cdpSession.removeAllListeners();

		this.cdpSession = null;

		this.emit("detached");
	}
};
