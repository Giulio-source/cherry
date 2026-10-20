import "dotenv/config";
import { Agent, fetch } from "undici";
import { writeFile, readFile } from "node:fs/promises";

type JiraScreen = {
  id: number;
  name: string;
  description?: string;
};

type JiraTab = {
  id: number;
  name: string;
};

type JiraField = {
  id: string;
  name: string;
};

type ScreenSnapshot = {
  environment: string;
  screen: JiraScreen;
  tabs: Array<{
    tab: JiraTab;
    fields: JiraField[];
  }>;
};

type ComparisonRow = {
  screen: string;
  dcScreenId: number | string;
  cloudScreenId: number | string;
  section: "screen" | "tab" | "field" | "error";
  tab: string;
  item: string;
  dcId: string | number;
  cloudId: string | number;
  dcPosition: number | string;
  cloudPosition: number | string;
  status: string;
  details: string;
};

type Page<T> = {
  values?: T[];
  screens?: T[];
  total?: number;
  isLast?: boolean;
};

const dcDispatcher = new Agent({
  connect: {
    rejectUnauthorized: false,
  },
});

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Variabile d'ambiente mancante: ${name}`);
  }

  return value.replace(/\/+$/, "");
}

function buildHeaders(environment: "dc" | "cloud") {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (environment === "dc") {
    //   "X-Atlassian-Token": "no-check",
    // "User-Agent": "curl/7.81.0"
    headers["X-Atlassian-Token"] = "no-check";
    headers["User-Agent"] = "curl/7.81.0";
  }

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
    ...(environment === "dc" ? { dispatcher: dcDispatcher } : {}),
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

  console.log(
    `\n[${environment.toUpperCase()}] Recupero di tutti gli screen...`,
  );

  while (true) {
    const endpoint = `/screens?startAt=${startAt}&maxResults=${pageSize}`;

    console.log(`[${environment.toUpperCase()}] GET ${endpoint}`);

    const result = await jiraGet<JiraScreen[] | Page<JiraScreen>>(
      environment,
      endpoint,
    );

    if (Array.isArray(result)) {
      console.log(
        `[${environment.toUpperCase()}] Risposta array: ${result.length} screen`,
      );

      screens.push(...result);
      break;
    }

    const values = result.values ?? result.screens ?? [];

    console.log(
      `[${environment.toUpperCase()}] Pagina: startAt=${startAt}, ` +
        `ricevuti=${values.length}, totale=${result.total ?? "sconosciuto"}, ` +
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
  }

  console.log(
    `\n[${environment.toUpperCase()}] Screen trovati: ${screens.length}`,
  );

  return screens;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

async function findScreen(
  environment: "dc" | "cloud",
  screenName: string,
): Promise<JiraScreen> {
  const screens = await getAllScreens(environment);

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
): Promise<ScreenSnapshot> {
  const screen = await findScreen(environment, screenName);

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

function printSnapshot(snapshot: ScreenSnapshot): void {
  console.log(`\n========== ${snapshot.environment} ==========`);

  console.log(
    JSON.stringify(
      {
        screen: snapshot.screen,
        tabs: snapshot.tabs.map(({ tab, fields }) => ({
          tab,
          fields: fields.map((field, index) => ({
            position: index + 1,
            ...field,
          })),
        })),
      },
      null,
      2,
    ),
  );
}

function buildComparisonRows(
  screenName: string,
  dc: ScreenSnapshot,
  cloud: ScreenSnapshot,
): ComparisonRow[] {
  const rows: ComparisonRow[] = [];

  const base = {
    screen: screenName,
    dcScreenId: dc.screen.id,
    cloudScreenId: cloud.screen.id,
  };

  rows.push({
    ...base,
    section: "screen",
    tab: "",
    item: screenName,
    dcId: dc.screen.id,
    cloudId: cloud.screen.id,
    dcPosition: "",
    cloudPosition: "",
    status: "FOUND_BOTH",
    details: "Screen trovato in entrambi gli ambienti",
  });

  const dcTabMap = new Map(
    dc.tabs.map((entry, index) => [
      normalize(entry.tab.name),
      { ...entry, position: index + 1 },
    ]),
  );

  const cloudTabMap = new Map(
    cloud.tabs.map((entry, index) => [
      normalize(entry.tab.name),
      { ...entry, position: index + 1 },
    ]),
  );

  const allTabKeys = [...new Set([...dcTabMap.keys(), ...cloudTabMap.keys()])];

  for (const key of allTabKeys) {
    const dcTab = dcTabMap.get(key);
    const cloudTab = cloudTabMap.get(key);
    const tabName = dcTab?.tab.name ?? cloudTab?.tab.name ?? key;

    let tabStatus: string;

    if (!dcTab) {
      tabStatus = "EXTRA_IN_CLOUD";
    } else if (!cloudTab) {
      tabStatus = "MISSING_IN_CLOUD";
    } else if (dcTab.position !== cloudTab.position) {
      tabStatus = "ORDER_DIFFERENT";
    } else {
      tabStatus = "MATCH";
    }

    rows.push({
      ...base,
      section: "tab",
      tab: tabName,
      item: tabName,
      dcId: dcTab?.tab.id ?? "",
      cloudId: cloudTab?.tab.id ?? "",
      dcPosition: dcTab?.position ?? "",
      cloudPosition: cloudTab?.position ?? "",
      status: tabStatus,
      details: "",
    });

    const dcFields = dcTab?.fields ?? [];
    const cloudFields = cloudTab?.fields ?? [];

    const dcFieldMap = new Map(
      dcFields.map((field, index) => [
        normalize(field.name),
        { field, position: index + 1 },
      ]),
    );

    const cloudFieldMap = new Map(
      cloudFields.map((field, index) => [
        normalize(field.name),
        { field, position: index + 1 },
      ]),
    );

    const allFieldKeys = [
      ...new Set([...dcFieldMap.keys(), ...cloudFieldMap.keys()]),
    ];

    for (const fieldKey of allFieldKeys) {
      const dcField = dcFieldMap.get(fieldKey);
      const cloudField = cloudFieldMap.get(fieldKey);

      let status: string;

      if (!dcTab) {
        status = "TAB_EXTRA_IN_CLOUD";
      } else if (!cloudTab) {
        status = "TAB_MISSING_IN_CLOUD";
      } else if (!dcField) {
        status = "EXTRA_IN_CLOUD";
      } else if (!cloudField) {
        status = "MISSING_IN_CLOUD";
      } else if (dcField.position !== cloudField.position) {
        status = "ORDER_DIFFERENT";
      } else {
        status = "MATCH";
      }

      rows.push({
        ...base,
        section: "field",
        tab: tabName,
        item: dcField?.field.name ?? cloudField?.field.name ?? fieldKey,
        dcId: dcField?.field.id ?? "",
        cloudId: cloudField?.field.id ?? "",
        dcPosition: dcField?.position ?? "",
        cloudPosition: cloudField?.position ?? "",
        status,
        details: "",
      });
    }
  }

  return rows;
}

function printComparison(rows: ComparisonRow[]): void {
  console.log("\n========== CONFRONTO ==========");
  console.table(
    rows.map((row) => ({
      sezione: row.section,
      tab: row.tab,
      elemento: row.item,
      DC: row.dcPosition,
      Cloud: row.cloudPosition,
      stato: row.status,
    })),
  );
}

function csvEscape(value: string | number): string {
  const text = String(value);

  if (/[",\r\n;]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

async function writeComparisonCsv(
  filePath: string,
  rows: ComparisonRow[],
): Promise<void> {
  const columns: (keyof ComparisonRow)[] = [
    "screen",
    "dcScreenId",
    "cloudScreenId",
    "section",
    "tab",
    "item",
    "dcId",
    "cloudId",
    "dcPosition",
    "cloudPosition",
    "status",
    "details",
  ];

  const lines = [
    columns.join(","),
    ...rows.map((row) =>
      columns.map((column) => csvEscape(row[column])).join(","),
    ),
  ];

  await writeFile(filePath, "\uFEFF" + lines.join("\r\n"), "utf8");

  console.log(`CSV creato: ${filePath}`);
  console.log(`Righe esportate: ${rows.length}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  function getArg(name: string): string | undefined {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  }

  const screenName = getArg("--screen")?.trim();
  const screensFile = getArg("--screens-file")?.trim();
  const csvFile = getArg("--csv")?.trim() || "jira-screen-comparison.csv";

  if (screensFile && screenName) {
    throw new Error("Usa --screen oppure --screens-file, non entrambi.");
  }

  if (!screensFile && !screenName) {
    throw new Error(
      'Uso singolo: npm run sync -- --screen "Nome screen"\n' +
        "Uso batch: npm run sync -- --screens-file screens.txt --csv risultati.csv",
    );
  }

  let screenNames: string[];

  if (screensFile) {
    const content = await readFile(screensFile, "utf8");

    screenNames = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    if (screenNames.length === 0) {
      throw new Error(`Nessuno screen trovato nel file ${screensFile}`);
    }

    console.log(`Screen caricati dal file: ${screenNames.length}`);
  } else {
    screenNames = [screenName!];
  }

  const allRows: ComparisonRow[] = [];

  for (const name of screenNames) {
    console.log(`\n========== ${name} ==========`);

    let dcSnapshot: ScreenSnapshot | undefined;
    let cloudSnapshot: ScreenSnapshot | undefined;
    let dcError = "";
    let cloudError = "";

    try {
      console.log("[DC] Lettura screen...");
      dcSnapshot = await getScreenSnapshot("dc", name);
      console.log("[DC] OK");
    } catch (error) {
      dcError = error instanceof Error ? error.message : String(error);
      console.error("[DC] ERRORE:", dcError);
    }

    try {
      console.log("[Cloud] Lettura screen...");
      cloudSnapshot = await getScreenSnapshot("cloud", name);
      console.log("[Cloud] OK");
    } catch (error) {
      cloudError = error instanceof Error ? error.message : String(error);
      console.error("[Cloud] ERRORE:", cloudError);
    }

    if (dcSnapshot && cloudSnapshot) {
      printSnapshot(dcSnapshot);
      printSnapshot(cloudSnapshot);

      const rows = buildComparisonRows(name, dcSnapshot, cloudSnapshot);

      printComparison(rows);
      allRows.push(...rows);
    } else {
      const base = {
        screen: name,
        dcScreenId: dcSnapshot?.screen.id ?? "",
        cloudScreenId: cloudSnapshot?.screen.id ?? "",
        section: "error" as const,
        tab: "",
        item: name,
        dcId: "",
        cloudId: "",
        dcPosition: "",
        cloudPosition: "",
      };

      if (!dcSnapshot) {
        allRows.push({
          ...base,
          status: "DC_ERROR",
          details: dcError,
        });
      }

      if (!cloudSnapshot) {
        allRows.push({
          ...base,
          status: "CLOUD_ERROR",
          details: cloudError,
        });
      }
    }
  }

  if (screensFile) {
    await writeComparisonCsv(csvFile, allRows);
  }

  const failed = allRows.filter(
    (row) => row.status === "DC_ERROR" || row.status === "CLOUD_ERROR",
  );

  console.log("\n========== RIEPILOGO ==========");
  console.log(`Screen richiesti: ${screenNames.length}`);
  console.log(`Righe risultato: ${allRows.length}`);
  console.log(`Errori di lettura: ${failed.length}`);

  if (screensFile) {
    console.log(`File CSV: ${csvFile}`);
  }

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
