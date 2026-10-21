export type ReorderReportRow = {
  screen: string;
  dcScreenId: number | string;
  cloudScreenId: number | string;
  status: string;
  extraCloudFieldCount: number;
  extraCloudFields: string;
  currentOrder: string;
  targetOrder: string;
  finalOrder: string;
  details: string;
};

export type JiraScreen = {
  id: number;
  name: string;
  description?: string;
};

export type JiraTab = {
  id: number;
  name: string;
};

export type JiraField = {
  id: string;
  name: string;
};

export type ScreenSnapshot = {
  environment: string;
  screen: JiraScreen;
  tabs: Array<{
    tab: JiraTab;
    fields: JiraField[];
  }>;
};

export type Page<T> = {
  values?: T[];
  screens?: T[];
  total?: number;
  isLast?: boolean;
};

export type TabReorderPlan = {
  tabName: string;
  tabId: number;
  currentFields: JiraField[];
  targetFields: JiraField[];
  extraCloudFields: JiraField[];
};
