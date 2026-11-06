import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Cloud,
  CloudOff,
  Download,
  FileText,
  Gauge,
  LogOut,
  ImagePlus,
  MapPin,
  Eye,
  EyeOff,
  Menu,
  Plus,
  Printer,
  School,
  Search,
  ShieldCheck,
  Users,
  Wifi,
  X,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { PHOTO_BUCKET, supabase } from "./supabase";

type Answers = Record<string, string>;
type FormState = {
  client_id: string;
  district: string;
  block: string;
  school_name: string;
  udise_code: string;
  school_type: string;
  inspection_date: string;
  officer_name: string;
  academics: Answers;
  infrastructure: Answers;
  sanitation: Answers;
  follow_up: Answers;
  priority: string;
  remarks: string;
};
type Inspection = {
  id: string;
  district: string;
  block: string;
  school_name: string;
  udise_code: string;
  school_type: string;
  inspection_date: string;
  officer_name: string;
  priority: string;
  remarks: string;
  details: Record<string, Answers>;
  photos: string[];
  created_at: string;
};
type Dashboard = {
  total_inspections: number;
  high_priority: number;
  districts_covered: number;
  districts: { name: string; count: number }[];
};
type User = { id: string; email: string; name: string; role: string };
type Page<T> = { items: T[]; total: number };

const PAGE_SIZE = 20;
const DRAFT_KEY = (uid: string) => `tn-school-inspection-draft-${uid}`;
const QUEUE_KEY = (uid: string) => `tn-school-inspection-queue-${uid}`;
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// crypto.randomUUID is unavailable on plain-http LAN origins (e.g. a phone on the local network).
function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const blankForm = (): FormState => ({
  client_id: newId(),
  district: "",
  block: "",
  school_name: "",
  udise_code: "",
  school_type: "",
  inspection_date: localToday(),
  officer_name: "",
  academics: {},
  infrastructure: {},
  sanitation: {},
  follow_up: {},
  priority: "Medium",
  remarks: "",
});

const steps = [
  { title: "School details", subtitle: "Basic information", icon: School },
  { title: "Academics", subtitle: "Learning & teaching", icon: BookOpen },
  { title: "Infrastructure", subtitle: "Facilities & safety", icon: Gauge },
  { title: "Sanitation", subtitle: "Hygiene & water", icon: ShieldCheck },
  { title: "Student follow-up", subtitle: "Additional support", icon: Users },
  {
    title: "Review & submit",
    subtitle: "Evidence & remarks",
    icon: ClipboardCheck,
  },
];

const sections: Record<
  number,
  { key: keyof FormState; title: string; fields: string[] }
> = {
  1: {
    key: "academics",
    title: "Academic observations",
    fields: [
      "Total students enrolled",
      "Students present today",
      "Total teachers",
      "Teachers present today",
      "Class-wise learning progress",
      "Textbook availability",
      "Teaching-learning materials",
      "Academic performance",
      "Students facing learning difficulties",
    ],
  },
  2: {
    key: "infrastructure",
    title: "Infrastructure observations",
    fields: [
      "Number of classrooms",
      "Classroom condition",
      "Electricity availability",
      "Drinking water availability",
      "Library",
      "Computer laboratory",
      "Playground",
      "Boundary wall",
      "Furniture condition",
      "Accessibility facilities",
    ],
  },
  3: {
    key: "sanitation",
    title: "Sanitation observations",
    fields: [
      "Boys' toilets",
      "Girls' toilets",
      "Functional toilet facilities",
      "Handwashing facilities",
      "Overall cleanliness",
      "Waste disposal",
      "Drinking water hygiene",
      "Menstrual hygiene facilities",
    ],
  },
  4: {
    key: "follow_up",
    title: "Student follow-up",
    fields: [
      "Students with irregular attendance",
      "Students who have dropped out",
      "Students requiring academic support",
      "Students requiring special attention",
      "Follow-up action taken",
      "Next follow-up date",
    ],
  },
};

const yesNoFields = new Set([
  "Electricity availability",
  "Drinking water availability",
  "Library",
  "Computer laboratory",
  "Playground",
  "Boundary wall",
  "Accessibility facilities",
  "Handwashing facilities",
  "Drinking water hygiene",
  "Menstrual hygiene facilities",
]);
const conditionFields = new Set([
  "Classroom condition",
  "Furniture condition",
  "Overall cleanliness",
  "Functional toilet facilities",
  "Textbook availability",
  "Teaching-learning materials",
]);
const countFields = new Set([
  "Total students enrolled",
  "Students present today",
  "Total teachers",
  "Teachers present today",
  "Number of classrooms",
  "Students with irregular attendance",
  "Students who have dropped out",
  "Students requiring academic support",
  "Students requiring special attention",
]);

// ---------- Supabase data layer ----------
// A missing status means a network failure; the offline queue relies on that distinction.
type ApiError = Error & { status?: number };
function apiError(message: string, status?: number): ApiError {
  const error = new Error(message) as ApiError;
  error.status = status || undefined;
  return error;
}

type InspectionRow = Omit<Inspection, "photos"> & {
  inspection_photos: { path: string }[] | null;
};
const INSPECTION_SELECT = "*, inspection_photos(path)";
const toInspection = ({
  inspection_photos,
  ...row
}: InspectionRow): Inspection => ({
  ...row,
  photos: (inspection_photos ?? []).map((p) => p.path),
});

async function loadUser(authUser: Session["user"]): Promise<User> {
  const { data } = await supabase
    .from("profiles")
    .select("name, role")
    .eq("id", authUser.id)
    .maybeSingle();
  const metaName =
    typeof authUser.user_metadata?.name === "string"
      ? authUser.user_metadata.name
      : "";
  return {
    id: authUser.id,
    email: authUser.email ?? "",
    name: data?.name || metaName || authUser.email || "Officer",
    role: data?.role ?? "officer",
  };
}

async function createInspection(current: FormState): Promise<Inspection> {
  const { data, error, status } = await supabase
    .from("inspections")
    .insert(toPayload(current))
    .select(INSPECTION_SELECT)
    .single();
  if (!error) return toInspection(data as InspectionRow);
  if (error.code === "23505") {
    // client_id already saved (a retry after a lost response): return that report, never a duplicate.
    const existing = await supabase
      .from("inspections")
      .select(INSPECTION_SELECT)
      .eq("client_id", current.client_id)
      .maybeSingle();
    if (existing.data) return toInspection(existing.data as InspectionRow);
    throw apiError("Duplicate submission id", 409);
  }
  throw apiError(error.message, status);
}

async function uploadPhoto(
  userId: string,
  inspectionId: string,
  file: File,
): Promise<void> {
  const ext =
    file.type === "image/png"
      ? "png"
      : file.type === "image/webp"
        ? "webp"
        : "jpg";
  const path = `${userId}/${inspectionId}/${newId()}.${ext}`;
  const upload = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(path, file, { contentType: file.type });
  if (upload.error) throw apiError(upload.error.message, 400);
  const { error, status } = await supabase
    .from("inspection_photos")
    .insert({ inspection_id: inspectionId, path });
  if (error) throw apiError(error.message, status);
}

async function fetchDashboard(): Promise<Dashboard> {
  const { data, error, status } = await supabase.rpc("dashboard_stats");
  if (error) throw apiError(error.message, status);
  return data as Dashboard;
}

async function fetchInspections(
  term: string,
  offset: number,
): Promise<Page<Inspection>> {
  let query = supabase
    .from("inspections")
    .select(INSPECTION_SELECT, { count: "exact" });
  // The term is wrapped in double quotes for PostgREST, so only quotes, backslashes and wildcards are stripped.
  const safe = term.replace(/["\\%*]/g, " ").trim();
  if (safe)
    query = query.or(
      ["school_name", "udise_code", "block", "district"]
        .map((column) => `${column}.ilike."%${safe}%"`)
        .join(","),
    );
  const { data, error, status, count } = await query
    .order("inspection_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw apiError(error.message, status);
  return {
    items: (data as InspectionRow[]).map(toInspection),
    total: count ?? 0,
  };
}

async function exportCsv(): Promise<Blob> {
  const { data, error, status } = await supabase
    .from("inspections")
    .select(
      "district, block, school_name, udise_code, inspection_date, officer_name, priority, remarks",
    )
    .order("inspection_date", { ascending: false });
  if (error) throw apiError(error.message, status);
  const cell = (raw: unknown) => {
    const value = String(raw ?? "");
    // Prefix formula-like cells so spreadsheets don't execute them.
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rows = (data as Record<string, unknown>[]).map((r) => [
    r.district,
    r.block,
    r.school_name,
    r.udise_code,
    r.inspection_date,
    r.officer_name,
    r.priority,
    r.remarks,
  ]);
  const lines = [
    ["District", "Block", "School", "UDISE", "Date", "Officer", "Priority", "Remarks"],
    ...rows,
  ].map((cells) => cells.map(cell).join(","));
  return new Blob(["\uFEFF" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
}

function readStoredForm(uid: string): FormState {
  try {
    const value = localStorage.getItem(DRAFT_KEY(uid));
    return value ? { ...blankForm(), ...JSON.parse(value) } : blankForm();
  } catch {
    return blankForm();
  }
}

function readQueue(uid: string): FormState[] {
  try {
    return JSON.parse(
      localStorage.getItem(QUEUE_KEY(uid)) ?? "[]",
    ) as FormState[];
  } catch {
    return [];
  }
}

function toPayload(current: FormState) {
  const {
    client_id,
    district,
    block,
    school_name,
    udise_code,
    school_type,
    inspection_date,
    officer_name,
    priority,
    remarks,
  } = current;
  return {
    client_id,
    district,
    block,
    school_name,
    udise_code,
    school_type,
    inspection_date,
    officer_name,
    priority,
    remarks,
    details: {
      academics: current.academics,
      infrastructure: current.infrastructure,
      sanitation: current.sanitation,
      follow_up: current.follow_up,
    },
  };
}

function validateCounts(form: FormState): string {
  const n = (section: Answers, key: string) =>
    section[key] === undefined || section[key] === ""
      ? null
      : Number(section[key]);
  const a = form.academics;
  const enrolled = n(a, "Total students enrolled"),
    present = n(a, "Students present today");
  const teachers = n(a, "Total teachers"),
    tPresent = n(a, "Teachers present today");
  if (enrolled !== null && present !== null && present > enrolled)
    return "Students present cannot exceed students enrolled.";
  if (teachers !== null && tPresent !== null && tPresent > teachers)
    return "Teachers present cannot exceed total teachers.";
  return "";
}

function PasswordInput({
  value,
  onChange,
  autoComplete,
  minLength,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  minLength?: number;
  maxLength?: number;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="password-wrap">
      <input
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        required
        minLength={minLength}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setShow(!show)}
        aria-label={show ? "Hide password" : "Show password"}
      >
        {show ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

function Login() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";
  function switchMode(next: "signin" | "signup") {
    setMode(next);
    setError("");
    setNotice("");
    setPassword("");
    setConfirm("");
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (signup && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      // A successful sign-in (or sign-up without email confirmation) is picked up by Root's auth listener.
      if (signup) {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: { data: { name: name.trim() } },
        });
        if (error) throw error;
        if (!data.session) {
          switchMode("signin");
          setNotice(
            "Account created. Check your email to confirm it, then sign in.",
          );
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });
        if (error)
          throw new Error(
            error.message === "Invalid login credentials"
              ? "Incorrect email or password"
              : error.message,
          );
      }
    } catch (issue) {
      setError(
        issue instanceof Error
          ? issue.message
          : signup
            ? "Could not sign up"
            : "Could not sign in",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark">
          <School size={23} />
        </div>
        <h1>TNSED</h1>
        <p>
          {signup
            ? "Create an account to record school inspections."
            : "Sign in to record school inspections."}
        </p>
        {notice && <div className="alert">{notice}</div>}
        {error && (
          <div className="alert error-alert">
            <AlertTriangle size={17} />
            {error}
          </div>
        )}
        {signup && (
          <Field label="Full name">
            <input
              type="text"
              autoComplete="name"
              required
              maxLength={150}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        )}
        <Field label="Email">
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <PasswordInput
            autoComplete={signup ? "new-password" : "current-password"}
            minLength={signup ? 8 : undefined}
            maxLength={8}
            value={password}
            onChange={setPassword}
          />
        </Field>
        {signup && (
          <Field label="Confirm password">
            <PasswordInput
              autoComplete="new-password"
              maxLength={8}
              value={confirm}
              onChange={setConfirm}
            />
          </Field>
        )}
        <button className="button button-primary" disabled={busy}>
          {signup
            ? busy
              ? "Creating account..."
              : "Sign up"
            : busy
              ? "Signing in..."
              : "Sign in"}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => switchMode(signup ? "signin" : "signup")}
        >
          {signup ? "Already have an account? Sign in" : "New user? Sign up"}
        </button>
      </form>
    </div>
  );
}

function Root() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let active = true;
    let currentId: string | null = null;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const authUser = session?.user ?? null;
      const nextId = authUser?.id ?? null;
      if (nextId === currentId) {
        setChecking(false); // token refresh or no session: nothing to reload
        return;
      }
      currentId = nextId;
      // Supabase calls must not run inside this callback, so defer them.
      window.setTimeout(async () => {
        const next = authUser ? await loadUser(authUser) : null;
        if (active && currentId === nextId) {
          setUser(next);
          setChecking(false);
        }
      }, 0);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);
  if (checking)
    return (
      <div className="login-page">
        <p>Loading...</p>
      </div>
    );
  if (!user) return <Login />;
  return (
    <App
      key={user.id}
      user={user}
      onLogout={() => void supabase.auth.signOut({ scope: "local" })}
    />
  );
}

function PhotoImg({ src, alt }: { src: string; alt: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let cancelled = false;
    // The bucket is private: a short-lived signed URL is issued only if storage RLS allows it.
    supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrl(src, 3600)
      .then(({ data }) => {
        if (!cancelled && data) setUrl(data.signedUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt={alt} />
    </a>
  ) : (
    <span className="photo-loading" />
  );
}

function App({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [page, setPage] = useState<"dashboard" | "new">("dashboard");
  const [form, setForm] = useState<FormState>(() => readStoredForm(user.id));
  const [step, setStep] = useState(0);
  const [dashboard, setDashboard] = useState<Dashboard>({
    total_inspections: 0,
    high_priority: 0,
    districts_covered: 0,
    districts: [],
  });
  const [reports, setReports] = useState<Inspection[]>([]);
  const [reportTotal, setReportTotal] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [queue, setQueue] = useState(() => readQueue(user.id));
  const [photos, setPhotos] = useState<File[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openReport, setOpenReport] = useState<Inspection | null>(null);
  const syncing = useRef(false);
  const submitting = useRef(false);
  const listRequest = useRef(0);

  const loadStats = useCallback(async () => {
    try {
      setDashboard(await fetchDashboard());
    } catch (issue) {
      setError(
        issue instanceof Error ? issue.message : "Could not load dashboard",
      );
    }
  }, []);

  const loadReports = useCallback(async (term: string, offset = 0) => {
    const id = ++listRequest.current;
    try {
      const result = await fetchInspections(term, offset);
      if (id !== listRequest.current) return; // a newer search superseded this one
      setReports((current) =>
        offset === 0 ? result.items : [...current, ...result.items],
      );
      setReportTotal(result.total);
    } catch (issue) {
      if (id === listRequest.current)
        setError(
          issue instanceof Error ? issue.message : "Could not load reports",
        );
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    void loadReports(debouncedSearch);
  }, [debouncedSearch, loadReports]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    localStorage.setItem(DRAFT_KEY(user.id), JSON.stringify(form));
  }, [form, user.id]);

  const refresh = useCallback(async () => {
    await Promise.all([loadStats(), loadReports(debouncedSearch)]);
  }, [loadStats, loadReports, debouncedSearch]);

  const syncQueue = useCallback(async () => {
    if (syncing.current || !navigator.onLine) return;
    const queued = readQueue(user.id);
    if (queued.length === 0) return;
    syncing.current = true;
    try {
      const remaining: FormState[] = [];
      let stop = false;
      for (const queuedForm of queued) {
        if (stop) {
          remaining.push(queuedForm);
          continue;
        }
        try {
          // The database de-duplicates on client_id, so a retry can never create a second report.
          await createInspection(queuedForm);
        } catch (issue) {
          remaining.push(queuedForm);
          if (
            (issue as { status?: number }).status === undefined ||
            (issue as { status?: number }).status === 401
          )
            stop = true;
        }
      }
      localStorage.setItem(QUEUE_KEY(user.id), JSON.stringify(remaining));
      setQueue(remaining);
      if (remaining.length < queued.length) {
        setSuccess(
          remaining.length === 0
            ? "Offline inspections synced successfully."
            : "Some offline inspections synced; the rest will retry.",
        );
        void refresh();
      }
    } finally {
      syncing.current = false;
    }
  }, [user.id, refresh]);

  useEffect(() => {
    const updateNetwork = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void syncQueue();
    };
    window.addEventListener("online", updateNetwork);
    window.addEventListener("offline", updateNetwork);
    void syncQueue();
    return () => {
      window.removeEventListener("online", updateNetwork);
      window.removeEventListener("offline", updateNetwork);
    };
  }, [syncQueue]);

  function updateField(key: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateAnswer(
    section: keyof FormState,
    label: string,
    value: string,
  ) {
    setForm((current) => ({
      ...current,
      [section]: { ...(current[section] as Answers), [label]: value },
    }));
  }

  function validateStep(currentStep: number): string {
    if (currentStep === 0) {
      if (
        !form.district ||
        !form.block.trim() ||
        !form.school_name.trim() ||
        !form.school_type ||
        !form.inspection_date ||
        !form.officer_name.trim()
      ) {
        return "Please complete all required school and officer details.";
      }
      if (!/^\d{11}$/.test(form.udise_code))
        return "Enter a valid 11-digit UDISE code.";
      if (form.inspection_date > localToday())
        return "Inspection date cannot be in the future.";
    }
    if (currentStep === 1) return validateCounts(form);
    return "";
  }

  function resetAfterSubmit() {
    setForm(blankForm());
    setPhotos([]);
    setStep(0);
    setPage("dashboard");
  }

  async function submitInspection() {
    if (submitting.current) return;
    for (const s of [0, 1]) {
      const validation = validateStep(s);
      if (validation) {
        setError(validation);
        setStep(s);
        return;
      }
    }
    submitting.current = true;
    setError("");
    setSuccess("");
    setLoading(true);
    const queueOffline = () => {
      const nextQueue = [
        ...readQueue(user.id).filter((q) => q.client_id !== form.client_id),
        form,
      ];
      localStorage.setItem(QUEUE_KEY(user.id), JSON.stringify(nextQueue));
      setQueue(nextQueue);
      setSuccess(
        "Inspection saved offline and queued to sync when you reconnect.",
      );
      resetAfterSubmit();
    };
    try {
      if (!navigator.onLine) {
        if (photos.length > 0) {
          setError(
            "Photo evidence needs an internet connection. Reconnect before submitting photos, or remove them to queue the report without images.",
          );
          return;
        }
        queueOffline();
        return;
      }
      let inspection: Inspection;
      try {
        inspection = await createInspection(form);
      } catch (issue) {
        // A network failure (no HTTP status) on a flaky connection: queue instead of losing the report.
        if (
          (issue as { status?: number }).status === undefined &&
          photos.length === 0
        ) {
          queueOffline();
          return;
        }
        throw issue;
      }
      if (photos.length > 0) {
        try {
          for (const photo of photos) {
            await uploadPhoto(user.id, inspection.id, photo);
            // Drop each uploaded photo so a retry only sends the ones that failed.
            setPhotos((current) => current.filter((item) => item !== photo));
          }
        } catch (issue) {
          // Report is saved; keep the form (same client_id) so pressing Submit again only retries the photos.
          await refresh();
          setError(
            `Report saved, but photos could not be uploaded (${issue instanceof Error ? issue.message : "error"}). Press Submit again to retry the photos.`,
          );
          return;
        }
      }
      resetAfterSubmit();
      setSuccess("Inspection report submitted successfully.");
      await refresh();
    } catch (issue) {
      setError(
        issue instanceof Error ? issue.message : "Could not submit report",
      );
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }

  function openNewInspection() {
    setError("");
    setSuccess("");
    setStep(0);
    setPage("new");
  }

  async function downloadCsv() {
    try {
      const blob = await exportCsv();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "school-inspections.csv";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (issue) {
      setError(
        issue instanceof Error ? issue.message : "Could not export reports",
      );
    }
  }

  const completedSteps = step;
  const fields = step > 0 && step < 5 ? sections[step] : undefined;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <School size={23} />
          </div>
          <div>
            <strong>TNSED</strong>
            <small>SCHOOL INSPECTION</small>
          </div>
          <button
            className="icon-button mobile-close"
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
          >
            <X size={19} />
          </button>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <button
          className={`nav-item ${page === "dashboard" ? "active" : ""}`}
          onClick={() => {
            setPage("dashboard");
            setMenuOpen(false);
          }}
        >
          <Activity size={18} /> Dashboard
        </button>
        <button
          className={`nav-item ${page === "new" ? "active" : ""}`}
          onClick={() => {
            openNewInspection();
            setMenuOpen(false);
          }}
        >
          <ClipboardCheck size={18} /> New inspection
        </button>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <div className="note-icon">
              <ShieldCheck size={18} />
            </div>
            <strong>Every school matters</strong>
            <p>Better insights today. Brighter futures tomorrow.</p>
          </div>
          <div className="officer-mini">
            <div className="avatar">{user.name.slice(0, 2).toUpperCase()}</div>
            <div>
              <strong>{user.name}</strong>
              <span>
                {user.role === "admin" ? "Administrator" : "Field officer"}
              </span>
            </div>
            <button
              className="icon-button logout"
              onClick={onLogout}
              aria-label="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      {menuOpen && (
        <button
          className="mobile-backdrop"
          onClick={() => setMenuOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <main className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button menu-toggle"
              onClick={() => setMenuOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb">
              Tamil Nadu <span>/</span>{" "}
              {page === "dashboard" ? "Overview" : "New inspection"}
            </span>
          </div>
          <div
            className={`connection ${online ? "connected" : "disconnected"}`}
          >
            {online ? <Wifi size={15} /> : <CloudOff size={15} />}
            {online ? "Online" : "Offline"}
            {queue.length > 0 && (
              <span className="queue-count">{queue.length} queued</span>
            )}
          </div>
        </header>

        <div className="page-wrap">
          {error && (
            <div className="alert error-alert">
              <AlertTriangle size={17} />
              {error}
              <button onClick={() => setError("")} aria-label="Dismiss">
                <X size={16} />
              </button>
            </div>
          )}
          {success && (
            <div className="alert success-alert">
              <CheckCircle2 size={17} />
              {success}
              <button onClick={() => setSuccess("")} aria-label="Dismiss">
                <X size={16} />
              </button>
            </div>
          )}
          {page === "dashboard" ? (
            <DashboardView
              userName={user.name}
              dashboard={dashboard}
              pendingSync={queue.length}
              search={search}
              onSearch={setSearch}
              onNew={openNewInspection}
              onExport={downloadCsv}
              reports={reports}
              total={reportTotal}
              onLoadMore={() =>
                void loadReports(debouncedSearch, reports.length)
              }
              onOpen={setOpenReport}
            />
          ) : (
            <section className="inspection-page">
              <div className="page-heading form-heading">
                <div>
                  <div className="eyebrow">
                    <span className="eyebrow-dot" /> FIELD INSPECTION
                  </div>
                  <h1>School inspection</h1>
                  <p>
                    Capture a complete picture of the school, one step at a
                    time.
                  </p>
                </div>
                <button
                  className="text-button"
                  onClick={() => setPage("dashboard")}
                >
                  <ArrowLeft size={16} /> Back to overview
                </button>
              </div>

              <div className="workflow">
                <div className="steps-rail">
                  {steps.map((item, index) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.title}
                        className={`step-item ${step === index ? "current" : ""} ${completedSteps > index ? "done" : ""}`}
                        onClick={() => {
                          if (index <= completedSteps) setStep(index);
                        }}
                      >
                        <span className="step-icon">
                          {completedSteps > index ? (
                            <Check size={17} />
                          ) : (
                            <Icon size={17} />
                          )}
                        </span>
                        <span className="step-copy">
                          <strong>{item.title}</strong>
                          <small>{item.subtitle}</small>
                        </span>
                        {index < steps.length - 1 && (
                          <span className="step-connector" />
                        )}
                      </button>
                    );
                  })}
                  <div className="progress-caption">
                    <span>FORM PROGRESS</span>
                    <strong>
                      {Math.round(((step + 1) / steps.length) * 100)}%
                    </strong>
                  </div>
                  <div className="progress-track">
                    <span
                      style={{ width: `${((step + 1) / steps.length) * 100}%` }}
                    />
                  </div>
                </div>

                <div className="form-card">
                  <div className="form-card-heading">
                    <div className="section-icon">
                      {(() => {
                        const Icon = steps[step].icon;
                        return <Icon size={20} />;
                      })()}
                    </div>
                    <div>
                      <h2>
                        {step === 0
                          ? "School & inspection details"
                          : step === 5
                            ? "Final inspection report"
                            : fields?.title}
                      </h2>
                      <p>
                        {steps[step].subtitle} · Step {step + 1} of{" "}
                        {steps.length}
                      </p>
                    </div>
                    <span className="required-note">
                      <i>*</i> Required fields
                    </span>
                  </div>

                  {step === 0 && (
                    <div className="field-grid">
                      <Field label="District" required>
                        <select
                          value={form.district}
                          onChange={(event) =>
                            updateField("district", event.target.value)
                          }
                        >
                          <option value="">Select district</option>
                          {[
                            "Ariyalur",
                            "Chengalpattu",
                            "Chennai",
                            "Coimbatore",
                            "Cuddalore",
                            "Dharmapuri",
                            "Dindigul",
                            "Erode",
                            "Kallakurichi",
                            "Kancheepuram",
                            "Kanniyakumari",
                            "Karur",
                            "Krishnagiri",
                            "Madurai",
                            "Mayiladuthurai",
                            "Nagapattinam",
                            "Namakkal",
                            "Nilgiris",
                            "Perambalur",
                            "Pudukkottai",
                            "Ramanathapuram",
                            "Ranipet",
                            "Salem",
                            "Sivaganga",
                            "Tenkasi",
                            "Thanjavur",
                            "Theni",
                            "Thoothukudi",
                            "Tiruchirappalli",
                            "Tirunelveli",
                            "Tirupathur",
                            "Tiruppur",
                            "Tiruvallur",
                            "Tiruvannamalai",
                            "Tiruvarur",
                            "Vellore",
                            "Viluppuram",
                            "Virudhunagar",
                          ].map((district) => (
                            <option key={district}>{district}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Block" required>
                        <input
                          value={form.block}
                          onChange={(event) =>
                            updateField("block", event.target.value)
                          }
                          placeholder="Enter block name"
                        />
                      </Field>
                      <Field label="School name" required>
                        <input
                          value={form.school_name}
                          onChange={(event) =>
                            updateField("school_name", event.target.value)
                          }
                          placeholder="Enter official school name"
                        />
                      </Field>
                      <Field
                        label="UDISE code"
                        required
                        hint="11-digit school identification code"
                      >
                        <input
                          inputMode="numeric"
                          maxLength={11}
                          value={form.udise_code}
                          onChange={(event) =>
                            updateField(
                              "udise_code",
                              event.target.value.replace(/\D/g, ""),
                            )
                          }
                          placeholder="e.g. 33010100101"
                        />
                      </Field>
                      <Field label="School type" required>
                        <select
                          value={form.school_type}
                          onChange={(event) =>
                            updateField("school_type", event.target.value)
                          }
                        >
                          <option value="">Select school type</option>
                          {[
                            "Government Primary",
                            "Government Middle",
                            "Government High",
                            "Government Higher Secondary",
                            "Aided",
                            "Other",
                          ].map((type) => (
                            <option key={type}>{type}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Date of inspection" required>
                        <input
                          type="date"
                          value={form.inspection_date}
                          onChange={(event) =>
                            updateField("inspection_date", event.target.value)
                          }
                        />
                      </Field>
                      <Field label="Inspecting officer" required>
                        <input
                          value={form.officer_name}
                          onChange={(event) =>
                            updateField("officer_name", event.target.value)
                          }
                          placeholder="Officer full name"
                        />
                      </Field>
                    </div>
                  )}

                  {fields && (
                    <div className="field-grid">
                      {fields.fields.map((label) => {
                        const value =
                          (form[fields.key] as Answers)[label] ?? "";
                        return (
                          <Field
                            key={label}
                            label={label}
                            wide={
                              label.includes("progress") ||
                              label.includes("difficulties") ||
                              label.includes("action")
                            }
                          >
                            {yesNoFields.has(label) ? (
                              <div className="choice-row">
                                {["Yes", "No", "Partial"].map((choice) => (
                                  <button
                                    key={choice}
                                    type="button"
                                    className={`choice-chip ${value === choice ? "selected" : ""}`}
                                    onClick={() =>
                                      updateAnswer(fields.key, label, choice)
                                    }
                                  >
                                    {choice}
                                  </button>
                                ))}
                              </div>
                            ) : conditionFields.has(label) ? (
                              <select
                                value={value}
                                onChange={(event) =>
                                  updateAnswer(
                                    fields.key,
                                    label,
                                    event.target.value,
                                  )
                                }
                              >
                                <option value="">Select status</option>
                                {[
                                  "Good",
                                  "Needs improvement",
                                  "Poor",
                                  "Not available",
                                ].map((option) => (
                                  <option key={option}>{option}</option>
                                ))}
                              </select>
                            ) : countFields.has(label) ? (
                              <input
                                type="number"
                                min="0"
                                value={value}
                                onChange={(event) =>
                                  updateAnswer(
                                    fields.key,
                                    label,
                                    event.target.value,
                                  )
                                }
                                placeholder="Enter count"
                              />
                            ) : label === "Next follow-up date" ? (
                              <input
                                type="date"
                                value={value}
                                onChange={(event) =>
                                  updateAnswer(
                                    fields.key,
                                    label,
                                    event.target.value,
                                  )
                                }
                              />
                            ) : (
                              <textarea
                                rows={3}
                                value={value}
                                onChange={(event) =>
                                  updateAnswer(
                                    fields.key,
                                    label,
                                    event.target.value,
                                  )
                                }
                                placeholder={`Add ${label.toLowerCase()} observations`}
                              />
                            )}
                          </Field>
                        );
                      })}
                    </div>
                  )}

                  {step === 5 && (
                    <div className="final-form">
                      <div className="field-grid">
                        <Field label="Priority level" required wide>
                          <div className="priority-options">
                            {["High", "Medium", "Low"].map((priority) => (
                              <button
                                type="button"
                                key={priority}
                                className={`priority-option priority-${priority.toLowerCase()} ${form.priority === priority ? "chosen" : ""}`}
                                onClick={() =>
                                  updateField("priority", priority)
                                }
                              >
                                <span className="priority-dot" />
                                <strong>{priority}</strong>
                                <small>
                                  {priority === "High"
                                    ? "Immediate attention"
                                    : priority === "Medium"
                                      ? "Follow up soon"
                                      : "Routine monitoring"}
                                </small>
                              </button>
                            ))}
                          </div>
                        </Field>
                        <Field label="Inspection remarks" wide>
                          <textarea
                            rows={4}
                            value={form.remarks}
                            onChange={(event) =>
                              updateField("remarks", event.target.value)
                            }
                            placeholder="Summarise key observations, actions taken and recommendations..."
                          />
                        </Field>
                        <Field
                          label="School photographs"
                          wide
                          hint="JPEG, PNG or WebP · Up to 10 MB per image"
                        >
                          <label className="upload-box">
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              multiple
                              onChange={(event) =>
                                setPhotos(Array.from(event.target.files ?? []))
                              }
                            />
                            <ImagePlus size={21} />
                            <span>
                              <strong>Add photo evidence</strong>
                              <small>Choose images from your device</small>
                            </span>
                            <span className="browse-button">Browse files</span>
                          </label>
                          {!online && (
                            <small className="field-hint">
                              Photo uploads need a connection. Inspection
                              details can still be queued offline.
                            </small>
                          )}
                          {photos.length > 0 && (
                            <div className="photo-list">
                              {photos.map((photo) => (
                                <span key={`${photo.name}-${photo.size}`}>
                                  <FileText size={14} />
                                  {photo.name}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setPhotos((current) =>
                                        current.filter(
                                          (item) => item !== photo,
                                        ),
                                      )
                                    }
                                    aria-label={`Remove ${photo.name}`}
                                  >
                                    <X size={14} />
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}
                        </Field>
                      </div>
                      <div className="review-summary">
                        <div className="review-icon">
                          <CheckCircle2 size={19} />
                        </div>
                        <div>
                          <strong>Ready to submit</strong>
                          <p>
                            Review your entries before sending this report to
                            the District Collector.
                          </p>
                        </div>
                        <span className="review-school">
                          {form.udise_code || "UDISE pending"}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="form-footer">
                    {step > 0 ? (
                      <button
                        className="button button-outline"
                        onClick={() => setStep((current) => current - 1)}
                      >
                        <ArrowLeft size={16} /> Previous
                      </button>
                    ) : (
                      <span className="autosave-note">
                        <Cloud size={15} /> Draft saved on this device
                      </span>
                    )}
                    <span className="footer-spacer" />
                    {step < 5 ? (
                      <button
                        className="button button-primary"
                        onClick={() => {
                          const message = validateStep(step);
                          if (message) setError(message);
                          else {
                            setError("");
                            setStep((current) => current + 1);
                          }
                        }}
                      >
                        Continue <ArrowRight size={16} />
                      </button>
                    ) : (
                      <button
                        className="button button-primary"
                        disabled={loading}
                        onClick={() => void submitInspection()}
                      >
                        {loading
                          ? "Submitting..."
                          : online
                            ? "Submit inspection"
                            : "Queue inspection"}
                        {!loading && <Check size={17} />}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </main>
      <nav className="bottom-nav" aria-label="Main">
        <button
          className={page === "dashboard" ? "active" : ""}
          onClick={() => setPage("dashboard")}
        >
          <Activity size={20} />
          Dashboard
        </button>
        <button
          className={page === "new" ? "active" : ""}
          onClick={openNewInspection}
        >
          <ClipboardCheck size={20} />
          New
        </button>
        <button onClick={onLogout}>
          <LogOut size={20} />
          Sign out
        </button>
      </nav>
      {openReport && (
        <ReportModal report={openReport} onClose={() => setOpenReport(null)} />
      )}
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  wide,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`field ${wide ? "field-wide" : ""}`}>
      <label>
        {label}
        {required && <i> *</i>}
      </label>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
    </div>
  );
}

function DashboardView({
  userName,
  dashboard,
  pendingSync,
  search,
  onSearch,
  onNew,
  onExport,
  reports,
  total,
  onLoadMore,
  onOpen,
}: {
  userName: string;
  dashboard: Dashboard;
  pendingSync: number;
  search: string;
  onSearch: (value: string) => void;
  onNew: () => void;
  onExport: () => void;
  reports: Inspection[];
  total: number;
  onLoadMore: () => void;
  onOpen: (report: Inspection) => void;
}) {
  return (
    <section className="dashboard-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span className="eyebrow-dot" /> DISTRICT MONITORING
          </div>
          <h1>School inspections</h1>
          <p>Field observations, bringing better decisions into focus.</p>
        </div>
        <button className="button button-primary" onClick={onNew}>
          <Plus size={17} /> New inspection
        </button>
      </div>

      <div className="welcome-strip">
        <div className="welcome-art">
          <div className="sun" />
          <div className="hill hill-one" />
          <div className="hill hill-two" />
          <School size={43} strokeWidth={1.4} />
        </div>
        <div className="welcome-copy">
          <span>VANAKKAM, {userName.toUpperCase()}</span>
          <h2>Every visit makes a difference.</h2>
          <p>Record what matters. Help every school move forward.</p>
        </div>
        <div className="welcome-mark">
          <span>தமிழ்நாடு</span>
          <small>SCHOOL EDUCATION</small>
        </div>
      </div>

      <div className="stats-grid">
        <StatCard
          label="Total inspections"
          value={dashboard.total_inspections}
          helper="Reports submitted"
          icon={<ClipboardCheck size={18} />}
          tone="green"
        />
        <StatCard
          label="High priority issues"
          value={dashboard.high_priority}
          helper="Need immediate attention"
          icon={<AlertTriangle size={18} />}
          tone="amber"
        />
        <StatCard
          label="Districts covered"
          value={dashboard.districts_covered}
          helper="Across Tamil Nadu"
          icon={<MapPin size={18} />}
          tone="blue"
        />
        <StatCard
          label="Pending sync"
          value={pendingSync}
          helper="Saved on this device"
          icon={<Cloud size={18} />}
          tone="purple"
        />
      </div>

      <div className="content-grid">
        <section className="panel reports-panel">
          <div className="panel-heading">
            <div>
              <h2>Recent inspections</h2>
              <p>Your latest submitted school reports</p>
            </div>
            <div className="report-actions">
              <button className="button button-light" onClick={onExport}>
                <Download size={15} /> Export
              </button>
            </div>
          </div>
          <div className="table-tools">
            <div className="search-box">
              <Search size={16} />
              <input
                placeholder="Search schools, UDISE, block..."
                value={search}
                onChange={(event) => onSearch(event.target.value)}
              />
            </div>
          </div>
          {reports.length > 0 ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>SCHOOL</th>
                    <th>UDISE CODE</th>
                    <th>INSPECTION DATE</th>
                    <th>PRIORITY</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {reports.map((report) => (
                    <tr key={report.id} onClick={() => onOpen(report)}>
                      <td>
                        <div className="school-cell">
                          <span className="school-avatar">
                            <School size={16} />
                          </span>
                          <span>
                            <strong>{report.school_name}</strong>
                            <small>
                              {report.block}, {report.district}
                            </small>
                          </span>
                        </div>
                      </td>
                      <td className="code-cell">{report.udise_code}</td>
                      <td>
                        {new Date(
                          `${report.inspection_date}T00:00:00`,
                        ).toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                      <td>
                        <span
                          className={`priority-badge ${report.priority.toLowerCase()}`}
                        >
                          <i />
                          {report.priority}
                        </span>
                      </td>
                      <td>
                        <button className="row-arrow" aria-label="View report">
                          <ArrowRight size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <div>
                <ClipboardCheck size={22} />
              </div>
              <strong>
                {search
                  ? "No matching schools"
                  : "Your first school visit starts here"}
              </strong>
              <p>
                {search
                  ? "Try searching by school name, block or UDISE code."
                  : "Create an inspection report to start tracking school conditions."}
              </p>
              {!search && (
                <button className="button button-outline" onClick={onNew}>
                  <Plus size={15} /> Start an inspection
                </button>
              )}
            </div>
          )}
          <div className="table-footer">
            <span>
              Showing <strong>{reports.length}</strong> of{" "}
              <strong>{total}</strong> reports
            </span>
            {reports.length < total ? (
              <button onClick={onLoadMore}>
                Load more <ArrowDown size={14} />
              </button>
            ) : (
              <button onClick={onExport}>
                Download report <ArrowRight size={14} />
              </button>
            )}
          </div>
        </section>

        <aside className="panel district-panel">
          <div className="panel-heading">
            <div>
              <h2>District coverage</h2>
              <p>Inspections by district</p>
            </div>
            <MapPin size={18} className="muted-icon" />
          </div>
          {dashboard.districts.length === 0 ? (
            <div className="district-empty">
              District data will appear as reports are submitted.
            </div>
          ) : (
            <div className="district-list">
              {dashboard.districts.slice(0, 6).map((district) => {
                const max = Math.max(
                  ...dashboard.districts.map((item) => item.count),
                  1,
                );
                return (
                  <div className="district-row" key={district.name}>
                    <div>
                      <strong>{district.name}</strong>
                      <span>
                        {district.count}{" "}
                        {district.count === 1 ? "inspection" : "inspections"}
                      </span>
                    </div>
                    <div className="district-progress">
                      <span
                        style={{
                          width: `${Math.max(8, (district.count / max) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="district-tip">
            <div>
              <Activity size={16} />
            </div>
            <p>
              <strong>Field insights</strong>
              <br />
              Consistent visits help identify needs early and direct support
              where it counts.
            </p>
          </div>
        </aside>
      </div>
      <footer className="page-foot">
        <span>Designed for public service. Built for every school.</span>
        <span>TAMIL NADU SCHOOL EDUCATION DEPARTMENT</span>
      </footer>
    </section>
  );
}

function StatCard({
  label,
  value,
  helper,
  icon,
  tone,
}: {
  label: string;
  value: number;
  helper: string;
  icon: React.ReactNode;
  tone: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        <span className={`stat-icon ${tone}`}>{icon}</span>
      </div>
      <strong className="stat-value">{value.toLocaleString("en-IN")}</strong>
      <span className="stat-helper">{helper}</span>
    </div>
  );
}

function ReportModal({
  report,
  onClose,
}: {
  report: Inspection;
  onClose: () => void;
}) {
  const detailLabels: Record<string, string> = {
    academics: "Academics",
    infrastructure: "Infrastructure",
    sanitation: "Sanitation",
    follow_up: "Student follow-up",
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="report-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">
              <span className="eyebrow-dot" /> INSPECTION REPORT
            </span>
            <h2>{report.school_name}</h2>
            <p>
              {report.block}, {report.district} · UDISE {report.udise_code}
            </p>
          </div>
          <button
            className="icon-button no-print"
            onClick={onClose}
            aria-label="Close report"
          >
            <X size={19} />
          </button>
        </div>
        <div className="modal-meta">
          <span>
            <strong>Inspection date</strong>
            {report.inspection_date}
          </span>
          <span>
            <strong>Officer</strong>
            {report.officer_name}
          </span>
          <span>
            <strong>Priority</strong>
            <span className={`priority-badge ${report.priority.toLowerCase()}`}>
              <i />
              {report.priority}
            </span>
          </span>
        </div>
        <div className="modal-body">
          {Object.entries(report.details ?? {}).map(([section, answers]) => (
            <div className="detail-section" key={section}>
              <h3>{detailLabels[section] ?? section}</h3>
              {Object.entries(answers)
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div className="detail-row" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
            </div>
          ))}
          {report.remarks && (
            <div className="detail-section">
              <h3>Inspection remarks</h3>
              <p className="remarks-copy">{report.remarks}</p>
            </div>
          )}
          {report.photos?.length > 0 && (
            <div className="detail-section">
              <h3>Photo evidence</h3>
              <div className="report-photos">
                {report.photos.map((photo) => (
                  <PhotoImg
                    key={photo}
                    src={photo}
                    alt="School inspection evidence"
                  />
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <span>{report.school_type}</span>
          <div className="modal-actions">
            <button
              className="button button-outline"
              onClick={() => window.print()}
            >
              <Printer size={15} /> Print / Save PDF
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export default Root;
