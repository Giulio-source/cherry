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

type ScreenReportRow = {
  screen: string;
  dcScreenId: number | string;
  cloudScreenId: number | string;
  status: string;
  missingTabs: string[];
  extraTabs: string[];
  missingFields: string[];
  extraFields: string[];
  orderDifferences: string[];
  errors: string[];
};

type TabReorderPlan = {
  tabName: string;
  tabId: number;
  currentFields: JiraField[];
  targetFields: JiraField[];
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
  rows: ScreenReportRow[],
): Promise<void> {
  const columns: (keyof ScreenReportRow)[] = [
    "screen",
    "dcScreenId",
    "cloudScreenId",
    "status",
    "missingTabs",
    "extraTabs",
    "missingFields",
    "extraFields",
    "orderDifferences",
    "errors",
  ];

  const lines = [
    columns.join(","),
    ...rows.map((row) =>
      columns
        .map((column) => {
          const value = row[column];
          const formatted = Array.isArray(value)
            ? value.length > 0
              ? value.join(" | ")
              : "—"
            : value === ""
              ? "—"
              : String(value);

          return csvEscape(formatted);
        })
        .join(","),
    ),
  ];

  await writeFile(filePath, "\uFEFF" + lines.join("\r\n"), "utf8");

  console.log(`CSV creato: ${filePath}`);
  console.log(`Screen esportati: ${rows.length}`);
}

function buildScreenReport(
  screenName: string,
  dc: ScreenSnapshot | undefined,
  cloud: ScreenSnapshot | undefined,
  errors: string[] = [],
): ScreenReportRow {
  const report: ScreenReportRow = {
    screen: screenName,
    dcScreenId: dc?.screen.id ?? "",
    cloudScreenId: cloud?.screen.id ?? "",
    status: "OK",
    missingTabs: [],
    extraTabs: [],
    missingFields: [],
    extraFields: [],
    orderDifferences: [],
    errors,
  };

  if (!dc || !cloud) {
    report.status = "ERRORE";
    return report;
  }

  const dcTabNames = dc.tabs.map(({ tab }) => normalize(tab.name));
  const cloudTabNames = cloud.tabs.map(({ tab }) => normalize(tab.name));

  report.missingTabs = dc.tabs
    .filter(({ tab }) => !cloudTabNames.includes(normalize(tab.name)))
    .map(({ tab }) => tab.name);

  report.extraTabs = cloud.tabs
    .filter(({ tab }) => !dcTabNames.includes(normalize(tab.name)))
    .map(({ tab }) => tab.name);

  if (dcTabNames.join("|") !== cloudTabNames.join("|")) {
    report.orderDifferences.push(
      `Ordine tab: DC [${dc.tabs.map(({ tab }) => tab.name).join(" → ")}] / ` +
        `Cloud [${cloud.tabs.map(({ tab }) => tab.name).join(" → ")}]`,
    );
  }

  for (const dcTab of dc.tabs) {
    const cloudTab = cloud.tabs.find(
      ({ tab }) => normalize(tab.name) === normalize(dcTab.tab.name),
    );

    if (!cloudTab) continue;

    const dcNames = dcTab.fields.map(({ name }) => normalize(name));
    const cloudNames = cloudTab.fields.map(({ name }) => normalize(name));

    report.missingFields.push(
      ...dcTab.fields
        .filter(({ name }) => !cloudNames.includes(normalize(name)))
        .map(({ name }) => `${name} (tab: ${dcTab.tab.name})`),
    );

    report.extraFields.push(
      ...cloudTab.fields
        .filter(({ name }) => !dcNames.includes(normalize(name)))
        .map(({ name }) => `${name} (tab: ${cloudTab.tab.name})`),
    );

    if (dcNames.join("|") !== cloudNames.join("|")) {
      report.orderDifferences.push(
        `Campi "${dcTab.tab.name}": DC [${dcTab.fields.map(({ name }) => name).join(" → ")}] / ` +
          `Cloud [${cloudTab.fields.map(({ name }) => name).join(" → ")}]`,
      );
    }
  }

  const hasDifferences =
    report.missingTabs.length > 0 ||
    report.extraTabs.length > 0 ||
    report.missingFields.length > 0 ||
    report.extraFields.length > 0 ||
    report.orderDifferences.length > 0;

  report.status = hasDifferences ? "DIFFERENZE" : "OK";

  return report;
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

function buildTabReorderPlans(
  dc: ScreenSnapshot,
  cloud: ScreenSnapshot,
): TabReorderPlan[] {
  const plans: TabReorderPlan[] = [];

  for (const dcTab of dc.tabs) {
    const cloudTab = cloud.tabs.find(
      ({ tab }) => normalize(tab.name) === normalize(dcTab.tab.name),
    );

    // Non modifichiamo tab che non esistono su entrambi gli ambienti.
    if (!cloudTab) {
      console.log(`[SKIP] Tab "${dcTab.tab.name}" non presente su Cloud.`);
      continue;
    }

    const usedCloudFieldIds = new Set<string>();
    const commonFields: JiraField[] = [];

    // Ordine DC: inseriamo i campi corrispondenti che esistono su Cloud.
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

    // I campi esclusivi di Cloud vengono mantenuti in fondo,
    // conservando tra loro l'ordine attuale.
    const cloudOnlyFields = cloudTab.fields.filter(
      (field) => !usedCloudFieldIds.has(field.id),
    );

    plans.push({
      tabName: cloudTab.tab.name,
      tabId: cloudTab.tab.id,
      currentFields: cloudTab.fields,
      targetFields: [...commonFields, ...cloudOnlyFields],
    });
  }

  return plans;
}

async function reorderScreenOnCloud(
  screenName: string,
  apply: boolean,
): Promise<void> {
  console.log(`Screen: "${screenName}"`);
  console.log(`Modalità: ${apply ? "APPLICAZIONE" : "ANTEPRIMA"}`);

  const dc = await getScreenSnapshot("dc", screenName);
  const cloud = await getScreenSnapshot("cloud", screenName);

  const plans = buildTabReorderPlans(dc, cloud);

  let moveCount = 0;

  for (const plan of plans) {
    const currentIds = plan.currentFields.map((field) => field.id);
    const targetIds = plan.targetFields.map((field) => field.id);

    const changed =
      currentIds.length !== targetIds.length ||
      currentIds.some((id, index) => id !== targetIds[index]);

    console.log(`\nTab: "${plan.tabName}"`);

    if (!changed) {
      console.log("  ✓ Ordine già corretto.");
      continue;
    }

    console.log("  Ordine attuale:");
    console.log(
      "   ",
      plan.currentFields.map((field) => field.name).join(" → "),
    );

    console.log("  Ordine desiderato:");
    console.log(
      "   ",
      plan.targetFields.map((field) => field.name).join(" → "),
    );

    if (!apply) {
      console.log("  Anteprima: nessuna modifica eseguita.");
      continue;
    }

    // Invertendo la sequenza e portando ogni campo in testa,
    // otteniamo l'ordine finale desiderato.
    for (const field of [...plan.targetFields].reverse()) {
      const endpoint =
        `/screens/${cloud.screen.id}/tabs/${plan.tabId}` +
        `/fields/${encodeURIComponent(field.id)}/move`;

      await jiraPostCloud(endpoint, {
        position: "First",
      });

      moveCount++;
      console.log(`  Spostato: ${field.name}`);
    }
  }

  if (!apply) {
    console.log(
      "\nAnteprima completata. Per applicare le modifiche, aggiungi --apply.",
    );
    return;
  }

  console.log(`\nSpostamenti richiesti: ${moveCount}`);
  console.log("Verifica dell'ordine su Cloud...");

  const verified = await getScreenSnapshot("cloud", screenName);
  const verificationPlans = buildTabReorderPlans(dc, verified);

  const differences = verificationPlans.filter((plan) => {
    const expected = plan.targetFields.map((field) => field.id);
    const actual = plan.currentFields.map((field) => field.id);

    return (
      expected.length !== actual.length ||
      expected.some((id, index) => id !== actual[index])
    );
  });

  if (differences.length > 0) {
    console.error(
      "ATTENZIONE: alcune tab non corrispondono ancora all'ordine desiderato:",
      differences.map((plan) => plan.tabName),
    );
    process.exitCode = 1;
  } else {
    console.log("✓ Verifica completata: ordine dei campi corretto.");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  function getArg(name: string): string | undefined {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  }

  const reorderScreenName = getArg("--reorder-screen")?.trim();
  const screenName = getArg("--screen")?.trim();
  const screensFile = getArg("--screens-file")?.trim();
  const csvFile = getArg("--csv")?.trim() || "jira-screen-comparison.csv";

  if (screensFile && screenName) {
    throw new Error("Usa --screen oppure --screens-file, non entrambi.");
  }
  
  if (reorderScreenName) {
    if (getArg("--screen") || getArg("--screens-file")) {
      throw new Error(
        "--reorder-screen non può essere combinato con --screen o --screens-file.",
      );
    }

    await reorderScreenOnCloud(reorderScreenName, args.includes("--apply"));

    return;
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

  const allRows: ScreenReportRow[] = [];

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

      const comparisonRows = buildComparisonRows(
        name,
        dcSnapshot,
        cloudSnapshot,
      );

      printComparison(comparisonRows);

      allRows.push(buildScreenReport(name, dcSnapshot, cloudSnapshot));
    } else {
      const errors = [
        ...(dcError ? [`DC: ${dcError}`] : []),
        ...(cloudError ? [`Cloud: ${cloudError}`] : []),
      ];

      allRows.push(buildScreenReport(name, dcSnapshot, cloudSnapshot, errors));
    }
  }

  if (screensFile) {
    await writeComparisonCsv(csvFile, allRows);
  }

  const failed = allRows.filter((row) => row.status === "ERRORE");

  console.log(`Screen elaborati: ${allRows.length}`);
  console.log(
    `Screen con differenze: ${
      allRows.filter((row) => row.status === "DIFFERENZE").length
    }`,
  );
  console.log(`Screen con errori: ${failed.length}`);

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
