const EventEmitter = require("events");

const SiderError = require("./Error");

let invalidInterceptionIdErrorShowed = false;
let sessionWithGivenIdNotFoundErrorShowed = false;

const printDebugLog = typeof process.env.SIDER_DEBUG === "string" &&
	process.env.SIDER_DEBUG.includes("network");

module.exports = class Network extends EventEmitter {
	constructor(browser, target) {
		super();

		this.browser = browser;
		this.target = target;
		this.webSocketSessions = new Map();

		// нельзя просто делать emit("response") потому что обработчики, в которых может быть запрошено тело запроса, будут асинхроннымы, и тогда все порушится
		this.requestHandler = null;
		this.responseHandler = null;

		this.webSocketMessageSentHandler = null;
		this.webSocketMessageReceivedHandler = null;

		this.requestFilter = null;
	}

	get cdp() {
		return this.target.cdp;
	}

	async initialize() {
		if (this.browser.optionHandleWebSocketRequests) await this.subscribeOnWebSocketRequests();

		await this.cdp.send("Fetch.enable", {
			handleAuthRequests: this.browser.optionHandleAuthRequests,
			patterns: [
				{ requestStage: "Request" },
				{ requestStage: "Response" }
			]
		});

		this.cdp.on("Fetch.requestPaused", async params => {
			// Fetch.requestPaused вызывается на оба requestStage, Request и Response
			// по идее, есть возможность менять полученный ответ (Fetch.fulfillRequest) или реджектить его (Fetch.failRequest)
			// пока что это не нужно

			// (this.debugPausedRequests = this.debugPausedRequests || {})[params.requestId] = params;

			const requestStageResponse = "responseErrorReason" in params ||
				"responseStatusCode" in params ||
				"responseStatusText" in params ||
				"responseHeaders" in params;

			if (requestStageResponse) {
				if (this.responseHandler) {
					await this.responseHandler(params);
				}

				// NOTE DIRTY
				// https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#method-continueResponse
				// По идее, тут надо юзать Fetch.continueResponse т.к. это requestStage Response
				// почему то в инкогнитоне все ламается из-за этого, (вообще помечено как EXPERIMENTAL)
				// так что пока что с оставим Fetch.continueRequest

				this.cdp.send("Fetch.continueRequest", { requestId: params.requestId })
					.catch(this.handleContinueRequestOrResponseError.bind(this));
			} else {
				if (this.requestHandler) {
					await this.requestHandler(params);
				}

				const passed = this.requestFilter ? this.requestFilter(params.request) : true;
				if (passed) {
					this.cdp.send("Fetch.continueRequest", { requestId: params.requestId })
						.catch(this.handleContinueRequestOrResponseError.bind(this));
				} else {
					this.cdp.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "Failed" })
						.catch(this.handleContinueRequestOrResponseError.bind(this));
				}
			}
		});

		this.cdp.on("Fetch.authRequired", params => {
			this.cdp.send("Fetch.continueWithAuth", {
				requestId: params.requestId,
				authChallengeResponse: {
					response: "ProvideCredentials",
					...this.credentials
				}
			});
		});
	}

	async subscribeOnWebSocketRequests() {
		await this.setNetworkEnable(true);

		this.cdp.on("Network.webSocketCreated", ({ requestId, url, initiator }) => {
			if (this.webSocketSessions.has(requestId)) throw new SiderError("Already has webSocketSession", { requestId, url });

			this.webSocketSessions.set(requestId, { url, initiator });
		});

		this.cdp.on("Network.webSocketClosed", ({ requestId, timestamp }) => {
			if (!this.webSocketSessions.has(requestId)) throw new SiderError("No webSocketSession", { requestId });

			this.webSocketSessions.delete(requestId);
		});

		this.cdp.on("Network.webSocketFrameSent", ({ requestId, timestamp, response }) => {
			if (this.webSocketMessageSentHandler) {
				const webSocketSession = this.webSocketSessions.get(requestId);
				if (!webSocketSession) throw new SiderError("No webSocketSession", { requestId });

				this.webSocketMessageSentHandler(webSocketSession.url, this.getWebSocketPayloadData(response));
			}
		});

		this.cdp.on("Network.webSocketFrameReceived", ({ requestId, timestamp, response }) => {
			if (this.webSocketMessageReceivedHandler) {
				const webSocketSession = this.webSocketSessions.get(requestId);
				if (!webSocketSession) throw new SiderError("No webSocketSession", { requestId });

				this.webSocketMessageReceivedHandler(webSocketSession.url, this.getWebSocketPayloadData(response));
			}
		});
	}

	async setNetworkEnable(value) {
		if (this.cdpNetworkEnable === value) return;

		this.cdpNetworkEnable = value;
		if (this.cdpNetworkEnable) {
			await this.cdp.send("Network.enable");
		} else {
			await this.cdp.send("Network.disable");
		}
	}

	async getResponseBody(requestId) {
		const bodyResult = await this.cdp.send("Fetch.getResponseBody", { requestId });

		return Buffer.from(bodyResult.body, bodyResult.base64Encoded && "base64");
	}

	async getResponseJson(response) {
		const body = await this.getResponseBody(response.requestId);

		return JSON.parse(body.toString() || "{}");
	}

	handleContinueRequestOrResponseError(error) {
		if (error.message.includes("Invalid InterceptionId")) {
			// оч непонятная ошибка, инфа по ней не гуглится
			// есть теория, что она появляется, когда фрейм рефрешится, или удаляется, или что-то такое
			// когда страница перезагружается, стабильно как будто возникает эта ошибка, т.е. получается суть такая,
			// поскольку мы перехватыает реквесты и респонсы, и обрабатываем их асинхронно, в это время страница (фрейм) может рефрешнуться и
			// тогда requestId станет уже неактуальным, вот и появляется ошибка
			// пока что будем игнорировать

			if (!invalidInterceptionIdErrorShowed) {
				invalidInterceptionIdErrorShowed = true;

				if (printDebugLog) console.log(`Invalid InterceptionId error on ${error.data.command.params.requestId}`);
				// if (printDebugLog) console.log(this.debugPausedRequests[error.data.command.params.requestId]);
			}
		} else if (error.message.includes("Session with given id not found")) {
			// обычно происходит, когда закрывается ВНЕЗАПНО вкладка

			if (!sessionWithGivenIdNotFoundErrorShowed) {
				sessionWithGivenIdNotFoundErrorShowed = true;

				if (printDebugLog) console.log(`Session with given id not found error on ${error.data.command.params.requestId}`);
			}
		} else {
			throw error;
		}
	}

	getWebSocketPayloadData(response) {
		// https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-WebSocketFrame
		// payloadData
		// string
		// WebSocket message payload data. If the opcode is 1, this is a text message and payloadData is a UTF-8 string.
		// If the opcode isn't 1, then payloadData is a base64 encoded string representing binary data.

		return response.opcode === 1
			? response.payloadData
			: Buffer.from(response.payloadData, "base64");
	}
};
