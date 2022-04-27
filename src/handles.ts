import { Bashrc, Config, FlashTypes, Test } from "./typings";
import { exampleConfig } from "./fixture";
import { commands, Terminal, window } from "vscode";
import { isConnectedToInternet, openSimpleBrowser } from "./components";
import { cd, ensureDirectoryIsEmpty } from "./usefuls";
import { handleMessage } from "./flash";
import { everythingButHandles } from ".";
import { createLoaderWebView } from "./loader";

// This is done to avoid circular imports.
// hours_of_my_life_lost_by_circular_imports += 2;
const allAvailableFunctions = {
  createBackgroundTerminal,
  ensureNoExtraKeys,
  getNotSets,
  handleConnection,
  handleEmptyDirectory,
  handleWorkspace,
  pollTerminal,
  rebuildAndReopenInContainer,
  sourceBashrc,
  ...everythingButHandles,
};

/**
 * Creates a terminal with the given name and executes the given commands.
 * @example
 * handleTerminal("freeCodeCamp: Open Course", "git clone something", "npm install", "live-server .")
 */
export function handleTerminal(name: string, ...commands: string[]) {
  const commandString = commands
    .join(" && ")
    .replace(/ ?([^&]+) && & && ([^&]+)/g, " ($1 & $2)");

  // If terminal already exists, then re-use it:
  const existingTerminal = window.terminals.find(
    (terminal) => terminal.name === name
  );
  if (existingTerminal) {
    existingTerminal.sendText(commandString);
    return existingTerminal;
  }
  const terminal = window.createTerminal(name);
  terminal.sendText(commandString, true);
  return terminal;
}

export async function createBackgroundTerminal(name: string, command: string) {
  const terminal = window.createTerminal(name);
  terminal.sendText(`${command} && exit`, true);
  const exitStatus = await pollTerminal(terminal);
  if (exitStatus) {
    terminal.dispose();
    return Promise.resolve(exitStatus);
  }
  return Promise.reject();
}

export async function pollTerminal(
  terminal: Terminal
): Promise<Terminal["exitStatus"]> {
  // Every 400ms, check if `terminal.exitStatus` is `undefined`. If it is not `undefined`, resolve promise to `terminal.exitStatus`.
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (terminal.exitStatus) {
        resolve(terminal.exitStatus);
        clearInterval(interval);
      }
    }, 400);
  });
}

// Does not work. Unsure why not.
export function rebuildAndReopenInContainer() {
  commands.executeCommand("remote-containers.rebuildAndReopenInContainer");
}

export async function handleConnection() {
  const isConnected = await isConnectedToInternet();
  if (!isConnected) {
    handleMessage({
      message: "No connection found. Please check your internet connection",
      type: FlashTypes.ERROR,
    });
    return Promise.reject();
  }
  return Promise.resolve();
}

export async function handleEmptyDirectory() {
  const isEmpty = await ensureDirectoryIsEmpty();
  if (!isEmpty) {
    handleMessage({
      message: "Directory is not empty.",
      type: FlashTypes.WARNING,
      opts: {
        detail: "Please empty working directory, and try again.",
        modal: true,
      },
    });

    return Promise.reject();
  }
  return Promise.resolve();
}

const scripts = {
  "develop-course": (path: string, val: string) => {
    handleTerminal("freeCodeCamp: Develop Course", cd(path, val));
  },
  "run-course": (path: string, val: string) => {
    handleTerminal("freeCodeCamp: Run Course", cd(path, val));
  },
  test: async (_path: string, val?: Test) => {
    try {
      const args = val?.arguments || [];
      // @ts-expect-error This is for testing. So, errors are not bad.
      const res = await allAvailableFunctions?.[val?.functionName]?.(...args);
      return Promise.resolve(res);
    } catch (e) {
      console.error(e);
      return Promise.reject(e);
    }
  },
};

export function sourceBashrc(val: Bashrc, path: string): void {
  if (val?.enabled) {
    createBackgroundTerminal(
      "freeCodeCamp: Source bashrc",
      cd(path, `source ${val.path}`)
    );
  }
}

async function handlePrepare(path: string, val: string) {
  const term = handleTerminal("freeCodeCamp: Preparing Course", cd(path, val));
  return pollTerminal(term);
}

export async function handleWorkspace(
  workspace: Config["workspace"],
  prepareTerminal: ReturnType<typeof handlePrepare>
): Promise<void> {
  if (workspace!.previews) {
    const compulsoryKeys = ["open"];
    for (const preview of workspace!.previews) {
      const notSets = getNotSets(preview, compulsoryKeys);
      if (notSets.length) {
        handleMessage({
          message: `Preview missing keys: ${notSets.join(", ")}`,
          type: FlashTypes.ERROR,
        });
        return Promise.reject();
      }
      if (preview.showLoader) {
        const panel = createLoaderWebView();
        // TODO: could use result here to show error in loader webview
        await prepareTerminal;
        panel.dispose();
      }

      if (preview?.open) {
        openSimpleBrowser(preview.url);
      }
    }
  }
  if (workspace!.terminals) {
    const compulsoryKeys = ["directory"];
    for (const term of workspace!.terminals) {
      const notSets = getNotSets(term, compulsoryKeys);
      if (notSets.length) {
        handleMessage({
          message: `Terminals missing keys: ${notSets.join(", ")}`,
          type: FlashTypes.ERROR,
        });
        return Promise.reject();
      }
      if (term?.name) {
        const t = handleTerminal(
          term.name,
          cd(term.directory, `echo ${term.message || ""}`)
        );
        if (term?.show) {
          t.show();
        }
      }
    }
  }
  if (workspace!.files) {
    const compulsoryKeys = ["name"];
    for (const file of workspace!.files) {
      const notSets = getNotSets(file, compulsoryKeys);
      if (notSets.length) {
        handleMessage({
          message: `Files missing keys: ${notSets.join(", ")}`,
          type: FlashTypes.ERROR,
        });
        return Promise.reject();
      }
      // TODO: Open file
    }
  }
  return Promise.resolve();
}

export async function handleConfig(
  config: Config,
  caller: keyof Config["scripts"]
) {
  // Ensure compulsory keys and values are set
  const path = config.path;
  const compulsoryKeys = [
    "path",
    "prepare",
    "scripts",
    "scripts.develop-course",
    "scripts.run-course",
  ];

  ensureNoExtraKeys(config, exampleConfig);

  const notSets = getNotSets<Config>(config, compulsoryKeys);
  if (notSets.length) {
    return handleMessage({
      type: FlashTypes.ERROR,
      message: `${notSets.join(", and ")} not set.`,
    });
  }

  // Run prepare script
  const prepareTerminal = handlePrepare(path, config.prepare);

  if (config.workspace) {
    await handleWorkspace(config.workspace, prepareTerminal);
  }

  const calledScript = config.scripts[caller];
  if (typeof calledScript === "string" && caller !== "test") {
    scripts[caller](path, calledScript);
  } else if (caller === "test" && typeof calledScript !== "string") {
    await scripts[caller](path, calledScript);
  }

  if (config.bashrc) {
    sourceBashrc(config.bashrc, path);
  }
}

export function getNotSets<T>(obj: T, compulsoryKeys: string[]) {
  return compulsoryKeys.filter((key) => !hasProp<T>(obj, key));
}

export function hasProp<T>(obj: T, keys: string): boolean {
  const keysArr = keys.split(".");
  let currObj: any = obj;
  for (const key of keysArr) {
    if (!currObj[key]) {
      return false;
    }
    currObj = currObj[key];
  }
  return true;
}

export function ensureNoExtraKeys(obj: any, exampleObject: any) {
  const unrecognisedKeys = [];
  for (const key in obj) {
    if (!exampleObject.hasOwnProperty(key)) {
      unrecognisedKeys.push(key);
      continue;
    }
    if (typeof obj[key] === "object") {
      ensureNoExtraKeys(obj[key], exampleObject[key]);
    }
  }
  if (unrecognisedKeys.length) {
    console.log(
      "There are keys that are not recognised in the `freecodecamp.conf.json` file. Double-check the specification."
    );
    handleMessage({
      type: FlashTypes.WARNING,
      message: `Unrecognised keys: ${unrecognisedKeys.join(", ")}`,
    });
  }
}
