const path = require("path");

const CLIArguments = require("./sider/CLIArguments");
const sider = require("./sider");

(async () => {
	const args = new CLIArguments();

	args.parseArrayArguments([
		"--start-maximized"
		// "--restore-last-session"
	]);

	args.set("--user-data-dir", path.resolve(__dirname, "userData", "browserData"));

	args.set("--auto-open-devtools-for-tabs");

	const browser = new sider.Browser({});

	await browser.launch({
		executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
		args
	});

	browser.on("closed", () => {
	});

	await browser.initialize();

	const page = await new Promise(resolve => {
		browser.once("pageAdded", page => {
			page.network.responseHandler = params => {
				const url = new URL(params.request.url);
				console.log(url.pathname);
			};

			return resolve(page);
		});
	});

	await page.navigate(require("./package.json").homepage);
})();
