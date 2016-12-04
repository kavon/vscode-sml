import * as childProcess from "child_process";
import * as events from "events";
import * as fs from "fs";
import * as path from "path";
import * as vs from "vscode";
import * as sml from "./language/sml";

class Pattern {
  public static readonly diagnostic: RegExp = /^(.+?):(\d+)\.(\d+)(?:-(\d+).(\d+))?\s(\b(?:Error)\b):\s(.*(?:\n\s+.*)*)/m;
}

class Session implements vs.Disposable {
  public readonly console: vs.OutputChannel;
  public readonly context: vs.ExtensionContext;
  public readonly sml: SML;
  public readonly subscriptions: vs.Disposable[] = [];

  constructor(context: vs.ExtensionContext) {
    this.console = vs.window.createOutputChannel("sml");
    this.context = context;
    this.sml = new SML(this);
    return this;
  }

  public dispose(): void {
    for (const item of this.subscriptions) item.dispose();
  }

  public async initialize(): Promise<void> {
    await this.sml.reload();
    this.subscriptions.push(vs.workspace.onDidSaveTextDocument(this.onDidSaveTextDocument.bind(this)));
  }

  public async onDidSaveTextDocument(document: vs.TextDocument): Promise<void> {
    if (document.languageId === "sml") await this.sml.make();
  }
}

class Transducer extends events.EventEmitter implements vs.Disposable {
  private lines: string[] = [];
  private pendingLine: string = "";
  private readonly session: Session;

  constructor(session: Session) {
    super();
    this.session = session;
    return this;
  }

  public dispose(): void {
    return;
  }

  public feed(data: Buffer | string): void {
    const lines = data.toString().split(/\n(?!\s)/m);
    while (lines.length > 0) {
      this.pendingLine += lines.shift();
      if (lines.length > 0) {
        this.lines.push(this.pendingLine);
        this.pendingLine = "";
      }
    }
    if (this.pendingLine === "- ") {
      this.pendingLine = "";
      this.emit("sml/lines", this.lines);
      this.lines = [];
    }
  }
}

class SML implements vs.Disposable {
  public prompted: boolean = false;
  public json: null | { cm: { "make/onSave": string } } = null;
  private readonly diagnostics: vs.DiagnosticCollection = vs.languages.createDiagnosticCollection("sml");
  private process: childProcess.ChildProcess;
  private readonly session: Session;
  private readonly statusItem: vs.StatusBarItem;
  private readonly subscriptions: vs.Disposable[] = [];
  private readonly transducer: Transducer;
  private readonly watcher: vs.FileSystemWatcher;

  constructor(session: Session) {
    this.session = session;
    this.transducer = new Transducer(session);
    this.watcher = vs.workspace.createFileSystemWatcher(path.join(vs.workspace.rootPath, "sml.json"));
    this.subscriptions.push(
      this.watcher.onDidChange(this.reload.bind(this)),
      this.watcher.onDidCreate(this.reload.bind(this)),
      this.watcher.onDidDelete(this.reload.bind(this)),
      this.statusItem = vs.window.createStatusBarItem(vs.StatusBarAlignment.Right, 1),
    );
    return this;
  }

  public async dispose(): Promise<void> {
    await this.disconnect();
    for (const item of this.subscriptions) item.dispose();
  }

  public async make(): Promise<void> {
    if (this.json && this.json.cm != null) await this.execute(`CM.make "${this.json.cm["make/onSave"]}"`);
  }

  public async reload(): Promise<void> {
    // this.session.console.clear();
    if (this.process != null) await this.disconnect();
    await this.initialize();
  }

  private async execute(command: string): Promise<boolean> {
    command += ";\n";
    return new Promise<boolean>((resolve) => {
      // this.session.console.clear();
      this.process.stdin.write(command, () => {
        // this.session.console.append(`- ${command}`);
        this.transducer.once("sml/lines", (response: string[]) => {
          const rootPath = vs.workspace.rootPath;
          const collatedDiagnostics: Map<vs.Uri, vs.Diagnostic[]> = new Map();
          let status = true;
          let match: RegExpMatchArray | null = null;
          this.diagnostics.clear();
          for (const line of response) {
            if ((match = line.match(Pattern.diagnostic)) == null) continue; // tslint:disable-line no-conditional-assignment
            match.shift(); // throw away entire match since we only want the captures
            const path = match.shift() as string;
            let uri: vs.Uri;
            try { uri = vs.Uri.parse(`file://${rootPath}/${path}`); } catch (err) { continue; } // uri parsing failed
            if (!collatedDiagnostics.has(uri)) collatedDiagnostics.set(uri, []);
            const diagnostics = collatedDiagnostics.get(uri) as vs.Diagnostic[];
            const startLine = parseInt(match.shift() as string, 10) - 1;
            const startChar = parseInt(match.shift() as string, 10) - 1;
            const   endLine = parseInt(match.shift() as string, 10) - 1 || startLine;
            const   endChar = parseInt(match.shift() as string, 10) - 1 || startChar;
            match.shift(); // skip diagnostic kind
            const message = match.shift() as string;
            const range = new vs.Range(startLine, startChar, endLine, endChar);
            const item = new vs.Diagnostic(range, message, vs.DiagnosticSeverity.Error);
            diagnostics.push(item);
          }
          this.diagnostics.set(Array.from(collatedDiagnostics.entries()));
          resolve(status);
        });
      });
    });
  }

  private async disconnect(): Promise<void> {
    await new Promise((resolve) => this.process.stdin.end(resolve)); // CTRL-D
    await new Promise((resolve) => this.process.on("exit", () => resolve()));
    delete this.process;
  }

  private async initialize(): Promise<void> {
    if (this.process != null) return; // FIXME: issue a warning
    if ((this.json = await this.loadSmlJson()) == null) return; // tslint:disable-line no-conditional-assignment
    const cwd = vs.workspace.rootPath;
    const sml = vs.workspace.getConfiguration("sml");
    const smlPath = sml.get<string>("smlnj.path");
    const smlArgs = sml.get<string[]>("smlnj.args");
    this.process = childProcess.spawn(smlPath, smlArgs, { cwd });
    this.process.stdout.on("data", this.transducer.feed.bind(this.transducer));
    this.process.on("error", (error: Error & { code: string }) => {
      if (error.code === "ENOENT") {
        vs.window.showWarningMessage(`Cannot find an sml binary at "${smlPath}".`);
        vs.window.showWarningMessage(`Double check your path or try configuring "sml.smlnj.path" under "User Settings".`);
        this.dispose();
        throw error;
     }
    });
    await new Promise((resolve) => this.transducer.once("sml/lines", resolve)); // wait for the first prompt
  }

  private async loadSmlJson(): Promise<null | { cm: { "make/onSave": string } }> {
    const cwd = vs.workspace.rootPath;
    const smlJsonPath = path.join(cwd, "sml.json");
    let json: null | { cm: { "make/onSave": string } } = null;
    try {
      json = await new Promise<any>((resolve, reject) => {
        fs.readFile(smlJsonPath, (err, data) => {
          if (err) {
            reject(err);
          } else {
            try {
              resolve(JSON.parse(data.toString()));
            } catch (err) {
              reject(err);
            }
          }
        });
      });
    } catch (err) {
      if (!this.prompted) {
        const sml = vs.workspace.getConfiguration("sml");
        if (!sml.get<boolean>("ignoreMissingSmlDotJson")) {
          await this.promptCreateSmlJson();
        }
      }
    }
    if (json && json.cm && json.cm["make/onSave"]) {
      this.statusItem.text = `[${json.cm["make/onSave"]}]`;
      this.statusItem.show();
      return json;
    } else {
      this.statusItem.hide();
      return null;
    }
  }

  private async promptCreateSmlJson(): Promise<null | string> {
    const cwd = vs.workspace.rootPath;
    await vs.window.showWarningMessage(`Cannot find "sml.json" in "${cwd}"`);
    const response: undefined | vs.MessageItem = await vs.window.showInformationMessage(`Shall we create an "sml.json" file for "CM.make"?`,
      {
        title: "Create",
      } as vs.MessageItem,
      {
        isCloseAffordance: true,
        title: "Ignore",
      },
    );
    if (response == null || response.title !== "Create") return null;
    const cmFile: undefined | string = await vs.window.showInputBox({
      prompt: "file:",
      validateInput: (input) => /\b\w+\.cm\b/.test(input) ? "" : "Input must be a cm file in root directory of project",
      value: "development.cm",
    });
    if (cmFile == null) return null;
    this.prompted = true;
    const data = { cm: { "make/onSave": cmFile } };
    await new Promise((resolve, reject) => fs.writeFile(path.join(cwd, "sml.json"), JSON.stringify(data, null, 2), (err) => err ? reject(err) : resolve()));
    await this.loadSmlJson();
    return cmFile;
  }
}

export async function activate(context: vs.ExtensionContext) {
  const session = new Session(context);
  await session.initialize();
  context.subscriptions.push(vs.languages.setLanguageConfiguration("sml", sml.configuration));
  context.subscriptions.push(session);
}

export function deactivate() {
  return;
}
