/**
 * akashic serve がどこで待ち受けているかを決める。
 *
 * WHY: `server.external` のモジュールは引数なしで呼ばれるので、ポートもホストも
 * 渡ってこない。ブラウザ側と違って `location` も無い。同じプロセスに居ることを
 * 使って、cli-serve 自身が持っている設定を読む。
 */
import { ServeOrigin } from "./playlog";

const DEFAULT_ORIGIN: ServeOrigin = {
    protocol: "http",
    hostname: "localhost",
    port: 3300,
};

export function resolveServeOrigin(specified?: string): ServeOrigin {
    return (
        parseOrigin(specified) ??
        parseOrigin(process.env["AKASHIC_SCOREBOARD_SERVE_ORIGIN"]) ??
        fromServerGlobalConfig() ??
        fromArgv() ??
        DEFAULT_ORIGIN
    );
}

function parseOrigin(value?: string): ServeOrigin | null {
    if (!value) {
        return null;
    }
    try {
        const url = new URL(value);
        const protocol = url.protocol.replace(":", "");
        return {
            protocol: protocol,
            hostname: url.hostname,
            port: url.port
                ? Number.parseInt(url.port, 10)
                : protocol === "https"
                  ? 443
                  : 80,
        };
    } catch (_err) {
        return null;
    }
}

/**
 * cli-serve は起動時の設定をモジュールスコープの singleton に持っている。
 * 我々は同じプロセスで require されるので、同じ実体を読める。
 *
 * WHY: これは cli-serve の内部で、公開 API ではない。版が変われば移動・改名が
 * ありうるので、読めなければ黙って次の手段へ落ちる。
 */
function fromServerGlobalConfig(): ServeOrigin | null {
    try {
        const mod =
            require("@akashic/akashic-cli-serve/lib/server/common/ServerGlobalConfig.js") as {
                serverGlobalConfig?: {
                    protocol?: string;
                    hostname?: string;
                    port?: number;
                };
            };
        const config = mod.serverGlobalConfig;
        if (!config || typeof config.port !== "number") {
            return null;
        }
        return {
            protocol: config.protocol ?? DEFAULT_ORIGIN.protocol,
            hostname: config.hostname ?? DEFAULT_ORIGIN.hostname,
            port: config.port,
        };
    } catch (_err) {
        return null;
    }
}

/**
 * WHY: cli-serve 自身も同じ argv から待ち受け先を決めている。内部に触れずに
 * 同じ答えが出る経路として残す。
 */
function fromArgv(): ServeOrigin | null {
    const port = readOption(["--port", "-p"]);
    const hostname = readOption(["--hostname"]);
    if (port == null && hostname == null) {
        return null;
    }
    return {
        protocol: DEFAULT_ORIGIN.protocol,
        hostname: hostname ?? DEFAULT_ORIGIN.hostname,
        port: port != null ? Number.parseInt(port, 10) : DEFAULT_ORIGIN.port,
    };
}

function readOption(names: string[]): string | null {
    const argv = process.argv;
    for (let i = 0; i < argv.length; i++) {
        for (const name of names) {
            if (argv[i] === name && i + 1 < argv.length) {
                return argv[i + 1];
            }
            if (argv[i].startsWith(name + "=")) {
                return argv[i].slice(name.length + 1);
            }
        }
    }
    return null;
}
