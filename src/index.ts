import "dotenv/config";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  JiraField,
  JiraScreen,
  JiraTab,
  Page,
  ReorderReportRow,
  ScreenSnapshot,
  TabReorderPlan,
} from "./types.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Variabile d'ambiente mancante: ${name}`);
  }

  return value.replace(/\/+$/, "");
}

function formatTimestamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${date.getFullYear()}-` +
    `${pad(date.getMonth() + 1)}-` +
    `${pad(date.getDate())}_` +
    `${pad(date.getHours())}-` +
    `${pad(date.getMinutes())}-` +
    `${pad(date.getSeconds())}`
  );
}

function buildHeaders(environment: "dc" | "cloud") {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (environment === "cloud") {
    const email = requiredEnv("CLOUD_EMAIL");
    const token = requiredEnv("CLOUD_API_TOKEN");

    headers.Authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  } else if (process.env.DC_PAT?.trim()) {
    headers.Authorization = `Bearer ${process.env.DC_PAT.trim()}`;
  } else {
    const username = requiredEnv("DC_USERNAME");
    const password = requiredEnv("DC_PASSWORD");

    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  return headers;
}

function baseUrl(environment: "dc" | "cloud"): string {
  return requiredEnv(environment === "dc" ? "DC_BASE_URL" : "CLOUD_BASE_URL");
}

function apiVersion(environment: "dc" | "cloud"): string {
  return environment === "dc" ? "2" : "3";
}

async function jiraGet<T>(
  environment: "dc" | "cloud",
  endpoint: string,
): Promise<T> {
  const url =
    `${baseUrl(environment)}/rest/api/${apiVersion(environment)}` + endpoint;

  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(environment),
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `[${environment.toUpperCase()}] GET ${endpoint} ` +
        `→ HTTP ${response.status}: ${body.slice(0, 500)}`,
    );
  }

  return response.json() as Promise<T>;
}

async function getAllScreens(
  environment: "dc" | "cloud",
): Promise<JiraScreen[]> {
  const screens: JiraScreen[] = [];
  const pageSize = 100;
  let startAt = 0;
  const tag = `[${environment.toUpperCase()}]`;

  console.log(`\n${tag} Recupero di tutti gli screen...`);

  // Mostra anche le cause annidate degli errori di rete/TLS.
  function logErrorDetails(error: unknown, depth = 0): void {
    const indent = "  ".repeat(depth);

    if (error instanceof Error) {
      console.error(`${indent}Nome: ${error.name}`);
      console.error(`${indent}Messaggio: ${error.message}`);

      const details = error as Error & {
        code?: string;
        cause?: unknown;
        errno?: string | number;
        syscall?: string;
        hostname?: string;
      };

      if (details.code) {
        console.error(`${indent}Codice: ${details.code}`);
      }

      if (details.errno !== undefined) {
        console.error(`${indent}Errno: ${details.errno}`);
      }

      if (details.syscall) {
        console.error(`${indent}Syscall: ${details.syscall}`);
      }

      if (details.hostname) {
        console.error(`${indent}Hostname: ${details.hostname}`);
      }

      if (depth === 0 && error.stack) {
        console.error(`${indent}Stack:\n${error.stack}`);
      }

      if (details.cause !== undefined) {
        console.error(`${indent}Causa:`);
        logErrorDetails(details.cause, depth + 1);
      }
    } else {
      console.error(`${indent}Dettaglio:`, error);
    }
  }

  console.log(`${tag} Base URL: ${baseUrl(environment)}`);
  console.log(`${tag} API version: ${apiVersion(environment)}`);

  while (true) {
    const endpoint = `/screens?startAt=${startAt}&maxResults=${pageSize}`;
    const pageNumber = Math.floor(startAt / pageSize) + 1;
    const startedAt = Date.now();

    console.log(`\n${tag} Pagina ${pageNumber}`);
    console.log(`${tag} GET ${endpoint}`);

    try {
      const result = await jiraGet<JiraScreen[] | Page<JiraScreen>>(
        environment,
        endpoint,
      );

      console.log(`${tag} Risposta ricevuta in ${Date.now() - startedAt} ms`);

      if (Array.isArray(result)) {
        console.log(`${tag} Formato array; screen ricevuti: ${result.length}`);

        screens.push(...result);
        break;
      }

      console.log(
        `${tag} Proprietà risposta: ${Object.keys(result ?? {}).join(", ")}`,
      );

      const values = result.values ?? result.screens ?? [];

      console.log(
        `${tag} Pagina: startAt=${startAt}, ` +
          `ricevuti=${values.length}, ` +
          `totale=${result.total ?? "sconosciuto"}, ` +
          `isLast=${result.isLast ?? "sconosciuto"}`,
      );

      screens.push(...values);
      startAt += values.length;

      if (
        result.isLast === true ||
        values.length === 0 ||
        (result.total !== undefined && startAt >= result.total)
      ) {
        break;
      }
    } catch (error: unknown) {
      console.error(`\n${tag} ERRORE durante il recupero degli screen`);
      console.error(`${tag} Endpoint: ${endpoint}`);
      console.error(`${tag} URL base: ${baseUrl(environment)}`);
      console.error(
        `${tag} Tempo prima dell'errore: ${Date.now() - startedAt} ms`,
      );
      console.error(`${tag} Screen già recuperati: ${screens.length}`);
      console.error(`${tag} Dettagli dell'errore:`);

      logErrorDetails(error);

      // Rilancia l'errore originale per non nascondere la causa.
      throw error;
    }
  }

  console.log(`\n${tag} Screen trovati: ${screens.length}`);

  return screens;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function findScreen(
  environment: "dc" | "cloud",
  screenName: string,
  screens: JiraScreen[],
): JiraScreen {
  const matches = screens.filter(
    (screen) => normalize(screen.name) === normalize(screenName),
  );

  if (matches.length === 0) {
    throw new Error(
      `[${environment.toUpperCase()}] Screen non trovato: "${screenName}"`,
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `[${environment.toUpperCase()}] Trovati più screen con nome ` +
        `"${screenName}". Selezione interrotta per sicurezza.`,
    );
  }

  return matches[0];
}

async function getScreenSnapshot(
  environment: "dc" | "cloud",
  screenName: string,
  screens: JiraScreen[],
): Promise<ScreenSnapshot> {
  const screen = findScreen(environment, screenName, screens);

  const tabs = await jiraGet<JiraTab[]>(
    environment,
    `/screens/${screen.id}/tabs`,
  );

  const snapshotTabs = await Promise.all(
    tabs.map(async (tab) => {
      const fields = await jiraGet<JiraField[]>(
        environment,
        `/screens/${screen.id}/tabs/${tab.id}/fields`,
      );

      return { tab, fields };
    }),
  );

  return {
    environment: environment.toUpperCase(),
    screen,
    tabs: snapshotTabs,
  };
}

function csvEscape(value: string | number): string {
  const text = String(value);

  if (/[",\r\n;]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

async function jiraPostCloud(endpoint: string, body: unknown): Promise<void> {
  const url = `${baseUrl("cloud")}/rest/api/${apiVersion("cloud")}` + endpoint;

  const headers = {
    ...buildHeaders("cloud"),
    "Content-Type": "application/json",
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();

    throw new Error(
      `[CLOUD] POST ${endpoint} → HTTP ${response.status}: ` +
        responseBody.slice(0, 500),
    );
  }
}

function formatPlanOrder(plans: TabReorderPlan[]): string {
  if (plans.length === 0) return "Nessuna tab confrontabile";

  return plans
    .map((plan) => {
      const extraIds = new Set(plan.extraCloudFields.map((field) => field.id));

      const formatFields = (fields: JiraField[]) =>
        fields
          .map((field) => `${field.name}${extraIds.has(field.id) ? "*" : ""}`)
          .join("\n") || "(nessun campo)";

      return `${plan.tabName.toLocaleUpperCase()}:\n${formatFields(plan.currentFields)}`;
    })
    .join("\n");
}

function formatTargetOrder(plans: TabReorderPlan[]): string {
  return (
    plans
      .map((plan) => {
        const extraIds = new Set(
          plan.extraCloudFields.map((field) => field.id),
        );

        const fields = plan.targetFields
          .map((field) => `${field.name}${extraIds.has(field.id) ? "*" : ""}`)
          .join("\n");

        return `${plan.tabName.toLocaleUpperCase()}:\n${fields || "(nessun campo)"}`;
      })
      .join("\n") || "Nessuna tab confrontabile"
  );
}

function getExtraCloudFieldSummary(plans: TabReorderPlan[]): string {
  return plans
    .flatMap((plan) =>
      plan.extraCloudFields.map(
        (field) => `${plan.tabName.toLocaleUpperCase()}: ${field.name}*`,
      ),
    )
    .join("\n");
}

function hasOrderDifferences(plans: TabReorderPlan[]): boolean {
  return plans.some((plan) => {
    const current = plan.currentFields.map((field) => field.id);
    const target = plan.targetFields.map((field) => field.id);

    return (
      current.length !== target.length ||
      current.some((id, index) => id !== target[index])
    );
  });
}

function buildTabReorderPlans(
  dc: ScreenSnapshot,
  cloud: ScreenSnapshot,
): TabReorderPlan[] {
  const plans: TabReorderPlan[] = [];

  for (const dcTab of dc.tabs) {
    const cloudTab = cloud.tabs.find(
      ({ tab }) => normalize(tab.name) === normalize(dcTab.tab.name),
    );

    if (!cloudTab) {
      console.log(`[SKIP] Tab "${dcTab.tab.name}" non presente su Cloud.`);
      continue;
    }

    const usedCloudFieldIds = new Set<string>();
    const commonFields: JiraField[] = [];

    for (const dcField of dcTab.fields) {
      const cloudField = cloudTab.fields.find(
        (field) =>
          normalize(field.name) === normalize(dcField.name) &&
          !usedCloudFieldIds.has(field.id),
      );

      if (cloudField) {
        commonFields.push(cloudField);
        usedCloudFieldIds.add(cloudField.id);
      }
    }

    const extraCloudFields = cloudTab.fields.filter(
      (field) => !usedCloudFieldIds.has(field.id),
    );

    plans.push({
      tabName: cloudTab.tab.name,
      tabId: cloudTab.tab.id,
      currentFields: cloudTab.fields,
      targetFields: [...commonFields, ...extraCloudFields],
      extraCloudFields,
    });
  }

  return plans;
}

async function reorderScreenOnCloud(
  screenName: string,
  apply: boolean,
  dcScreens: JiraScreen[],
  cloudScreens: JiraScreen[],
): Promise<ReorderReportRow> {
  const report: ReorderReportRow = {
    screen: screenName,
    dcScreenId: "",
    cloudScreenId: "",
    status: "ERRORE",
    extraCloudFieldCount: 0,
    extraCloudFields: "",
    currentOrder: "",
    targetOrder: "",
    finalOrder: "",
    details: "",
  };

  try {
    console.log(`\n========== ${screenName} ==========`);
    console.log(`Modalità: ${apply ? "APPLICAZIONE" : "ANTEPRIMA"}`);

    const dc = await getScreenSnapshot("dc", screenName, dcScreens);
    const cloud = await getScreenSnapshot("cloud", screenName, cloudScreens);

    report.dcScreenId = dc.screen.id;
    report.cloudScreenId = cloud.screen.id;

    const plans = buildTabReorderPlans(dc, cloud);
    const needsReorder = hasOrderDifferences(plans);

    report.extraCloudFieldCount = plans.reduce(
      (total, plan) => total + plan.extraCloudFields.length,
      0,
    );

    report.extraCloudFields = getExtraCloudFieldSummary(plans);
    report.currentOrder = formatPlanOrder(plans);
    report.targetOrder = formatTargetOrder(plans);

    console.log("\nOrdine attuale (* = campo solo Cloud):");
    console.log(report.currentOrder);

    console.log("\nOrdine target:");
    console.log(report.targetOrder);

    console.log(`\nCampi extra Cloud: ${report.extraCloudFieldCount}`);

    if (!needsReorder) {
      report.status = "OK";
      report.details = "L'ordine è già corretto.";
      report.finalOrder = report.currentOrder;

      console.log("✓ Ordine già corretto.");
      return report;
    }

    if (!apply) {
      report.status = "DA_RIORDINARE";
      report.details = "Anteprima: nessuna modifica eseguita.";

      console.log("Anteprima completata: nessuna modifica eseguita.");
      return report;
    }

    let moveCount = 0;

    for (const plan of plans) {
      const currentIds = plan.currentFields.map((field) => field.id);
      const targetIds = plan.targetFields.map((field) => field.id);

      const changed =
        currentIds.length !== targetIds.length ||
        currentIds.some((id, index) => id !== targetIds[index]);

      if (!changed) continue;

      // Sposta in testa partendo dall'ultimo elemento target.
      for (const field of [...plan.targetFields].reverse()) {
        const endpoint =
          `/screens/${cloud.screen.id}/tabs/${plan.tabId}` +
          `/fields/${encodeURIComponent(field.id)}/move`;

        await jiraPostCloud(endpoint, {
          position: "First",
        });

        moveCount++;
        console.log(
          `[Cloud] Spostato "${field.name}" nella tab "${plan.tabName}"`,
        );
      }
    }

    report.details = `Spostamenti richiesti: ${moveCount}. Verifica in corso.`;

    const verified = await getScreenSnapshot("cloud", screenName, cloudScreens);
    const verificationPlans = buildTabReorderPlans(dc, verified);

    report.finalOrder = formatPlanOrder(verificationPlans);

    const verificationFailed = hasOrderDifferences(verificationPlans);

    if (verificationFailed) {
      report.status = "VERIFICA_FALLITA";
      report.details =
        `Spostamenti richiesti: ${moveCount}. ` +
        "L'ordine finale non corrisponde a quello target.";
    } else {
      report.status = "RIORDINATO";
      report.details = `Riordino completato e verificato. Spostamenti: ${moveCount}.`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    report.status = "ERRORE";
    report.details = message;

    console.error(`[ERRORE] ${screenName}: ${message}`);
  }

  return report;
}

async function writeReorderCsv(
  filePath: string,
  rows: ReorderReportRow[],
): Promise<void> {
  const columns: { key: keyof ReorderReportRow; label: string }[] = [
    { key: "screen", label: "Nome schermata" },
    { key: "dcScreenId", label: "ID schermata Jira Data Center" },
    { key: "cloudScreenId", label: "ID schermata Jira Cloud" },
    { key: "status", label: "Esito elaborazione" },
    { key: "extraCloudFieldCount", label: "Numero campi aggiuntivi su Cloud" },
    { key: "extraCloudFields", label: "Campi aggiuntivi su Cloud" },
    { key: "currentOrder", label: "Ordine iniziale dei campi su Cloud" },
    { key: "targetOrder", label: "Ordine previsto dei campi" },
    { key: "finalOrder", label: "Ordine finale dei campi su Cloud" },
    { key: "details", label: "Dettaglio elaborazione" },
  ];

  const lines = [
    columns.map(({ label }) => csvEscape(label)).join(";"),
    ...rows.map((row) =>
      columns.map(({ key }) => csvEscape(row[key])).join(";"),
    ),
  ];

  await writeFile(filePath, "\uFEFF" + lines.join("\r\n"), "utf8");

  console.log(`\nCSV creato: ${filePath}`);
  console.log(`Screen riportati: ${rows.length}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  function getArg(name: string): string | undefined {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  }

  const screensFile = getArg("--reorder-screens-file")?.trim();

  if (!screensFile || screensFile.startsWith("--")) {
    throw new Error(
      "Uso: npm run sync -- --reorder-screens-file screens.txt [--csv report.csv] [--apply]",
    );
  }

  const apply = args.includes("--apply");

  const content = await readFile(screensFile, "utf8");
  const screenNames = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (screenNames.length === 0) {
    throw new Error(`Nessuno screen trovato nel file ${screensFile}`);
  }

  console.log(`File input: ${screensFile}`);
  console.log(`Screen da elaborare: ${screenNames.length}`);
  console.log(`Modalità: ${apply ? "APPLY" : "ANTEPRIMA"}`);

  const exportDir = "exports";

  await mkdir(exportDir, { recursive: true });

  const csvFile = join(exportDir, `reorder-report-${formatTimestamp()}.csv`);

  const reports: ReorderReportRow[] = [];

  const [dcScreens, cloudScreens] = await Promise.all([
    getAllScreens("dc"),
    getAllScreens("cloud"),
  ]);

  for (const name of screenNames) {
    reports.push(
      await reorderScreenOnCloud(name, apply, dcScreens, cloudScreens),
    );
  }

  await writeReorderCsv(csvFile, reports);

  console.log("\n========== RIEPILOGO RIORDINO ==========");
  console.log(`Screen elaborati: ${reports.length}`);
  console.log(
    `Da riordinare: ${reports.filter((row) => row.status === "DA_RIORDINARE").length}`,
  );
  console.log(
    `Riordinati: ${reports.filter((row) => row.status === "RIORDINATO").length}`,
  );
  console.log(
    `Campi extra Cloud: ${reports.reduce((sum, row) => sum + row.extraCloudFieldCount, 0)}`,
  );

  const failed = reports.filter(
    (row) => row.status === "ERRORE" || row.status === "VERIFICA_FALLITA",
  );
  console.log(`Errori: ${failed.length}`);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    "\nERRORE FATALE:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
