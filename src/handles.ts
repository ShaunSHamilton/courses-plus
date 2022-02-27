import { Bashrc, Config, Flash, FlashTypes, Test } from "./typings";
import { exampleConfig } from "./fixture";
import { commands, Terminal, window } from "vscode";
import {
  currentDirectoryCourse,
  getRootWorkspaceDir,
  isConnectedToInternet,
  openSimpleBrowser,
  openTerminal,
} from "./components";
import {
  cd,
  ensureDirectoryIsEmpty,
  ensureFileOrFolder,
  getPackageJson,
} from "./usefuls";
import { promptQuickPick, showInputBox } from "./inputs";

const showMessage = (shower: Function) => (s: string, opts: Flash["opts"]) =>
  shower(s, opts);

const flasher = {
  [FlashTypes.INFO]: showMessage(window.showInformationMessage),
  [FlashTypes.WARNING]: showMessage(window.showWarningMessage),
  [FlashTypes.ERROR]: showMessage(window.showErrorMessage),
};

export function handleMessage(flash: Flash) {
  console.log("handled message", flash);
  flasher[flash.type](flash.message, flash.opts);
}

/**
 * Creates a terminal with the given name and executes the given commands.
 * @example
 * handleTerminal("freeCodeCamp: Open Course", "git clone something", "npm install", "live-server .")
 */
export function handleTerminal(name: string, ...commands: string[]) {
  const commandString = commands
    .join(" && ")
    .replace(/ ?([^&]+) && & && ([^&]+)/g, " ($1 & $2)");
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
    // @ts-expect-error This is for testing. So, errors are not bad.
    console.log("testing", val, allAvailableFunctions?.[val?.functionName]);
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

function sourceBashrc(val: Bashrc, path: string): void {
  if (val?.enabled) {
    createBackgroundTerminal(
      "freeCodeCamp: Source bashrc",
      cd(path, `source ${val.path}`)
    );
  }
}

async function handleWorkspace(workspace: Config["workspace"]): Promise<void> {
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
      if (preview?.open) {
        // Timeout for to ensure server is running
        await new Promise((resolve) =>
          setTimeout(resolve, preview?.timeout || 100)
        );
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

  const calledScript = config.scripts[caller];
  console.log("handling: ", calledScript, caller);
  if (typeof calledScript === "string" && caller !== "test") {
    scripts[caller](path, calledScript);
  } else if (caller === "test" && typeof calledScript !== "string") {
    await scripts[caller](path, calledScript);
  }

  if (config.bashrc) {
    sourceBashrc(config.bashrc, path);
  }
  if (config.workspace) {
    await handleWorkspace(config.workspace);
  }
}

function getNotSets<T>(obj: T, compulsoryKeys: string[]) {
  return compulsoryKeys.filter((key) => !hasProp<T>(obj, key));
}

function hasProp<T>(obj: T, keys: string): boolean {
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

function ensureNoExtraKeys(obj: any, exampleObject: any) {
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

const allAvailableFunctions = {
  handleMessage: handleMessage,
  handleConnection: handleConnection,
  handleEmptyDirectory: handleEmptyDirectory,
  createBackgroundTerminal: createBackgroundTerminal,
  showMessage: showMessage,
  sourceBashrc: sourceBashrc,
  openTerminal: openTerminal,
  openSimpleBrowser: openSimpleBrowser,
  currentDirectoryCourse: currentDirectoryCourse,
  getRootWorkspaceDir: getRootWorkspaceDir,
  isConnectedToInternet: isConnectedToInternet,
  pollTerminal: pollTerminal,
  rebuildAndReopenInContainer,
  handleWorkspace,
  getNotSets,
  ensureNoExtraKeys,
  showInputBox,
  promptQuickPick,
  ensureDirectoryIsEmpty,
  getPackageJson,
  ensureFileOrFolder,
};
