module.exports = {
	tick(lastTick = undefined) {
		return process.hrtime(lastTick);
	},
	tickToMilliseconds(tick) {
		return tick[0] * 1000 + tick[1] / 1000000;
	}
};
