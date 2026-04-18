import React, { useState, useEffect } from 'react';
import { 
  onSnapshot, 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  query, 
  orderBy, 
  limit,
  Timestamp
} from 'firebase/firestore';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User
} from 'firebase/auth';
import { db, auth } from './lib/firebase';
import { cn } from './lib/utils';
import { 
  Settings as SettingsIcon, 
  History, 
  Play, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  Mail, 
  FileText,
  RefreshCw,
  LogOut,
  ChevronRight,
  Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import cron from 'cron-parser';
import { formatDistanceToNow, format } from 'date-fns';

// --- Utilities ---

const logger = {
  log: (message: string, context?: string) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]${context ? ` [${context}]` : ''} ${message}`);
  },
  error: (message: string, context?: string, error?: any) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}]${context ? ` [${context}]` : ''} ERROR: ${message}`, error || '');
  }
};

const isHebrew = (text: string) => {
  const hebrewPattern = /[\u0590-\u05FF]/;
  return hebrewPattern.test(text);
};

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null, context?: string) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  logger.error(`Firestore Error: ${errInfo.error}`, context || 'Firestore', errInfo);
  throw new Error(JSON.stringify(errInfo));
}

// --- Types ---
interface Settings {
  interval: string;
  recipients: string[];
  summaryPrompt: string;
  reportFormat: string;
  updatedAt: string;
}

interface Report {
  id: string;
  title: string;
  content: string;
  timestamp: Timestamp;
  status: 'success' | 'failed';
  stage?: string;
  request?: string;
  error?: string;
}

// --- Components ---

const Button = ({ 
  children, 
  onClick, 
  className, 
  variant = 'primary',
  disabled = false,
  icon: Icon,
  type = 'button'
}: { 
  children: React.ReactNode; 
  onClick?: () => void; 
  className?: string; 
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
  disabled?: boolean;
  icon?: any;
  type?: 'button' | 'submit' | 'reset';
}) => {
  const variants = {
    primary: 'bg-ink text-bg hover:bg-[#141414]/90 shadow-[4px_4px_0px_0px_rgba(20,20,20,0.2)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px]',
    secondary: 'bg-bg text-ink border border-ink hover:bg-[#E4E3E0]/80 shadow-[4px_4px_0px_0px_rgba(20,20,20,0.1)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px]',
    outline: 'border border-ink text-ink hover:bg-ink hover:text-bg transition-colors',
    ghost: 'text-ink hover:bg-[#141414]/5'
  };

  return (
    <button 
      onClick={onClick}
      disabled={disabled}
      type={type}
      className={cn(
        "flex items-center justify-center gap-2 px-4 py-2 font-mono text-xs uppercase tracking-widest transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed",
        variants[variant],
        className
      )}
    >
      {Icon && <Icon size={14} />}
      {children}
    </button>
  );
};

const Card = ({ children, title, icon: Icon, className }: { children: React.ReactNode; title?: string; icon?: any; className?: string }) => (
  <div className={cn("relative overflow-hidden border border-ink bg-white p-6 shadow-[8px_8px_0px_0px_rgba(20,20,20,0.05)]", className)}>
    {title && (
      <div className="mb-6 flex items-center justify-between border-b border-ink pb-2">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={16} className="text-ink" />}
          <h2 className="font-serif text-sm italic tracking-widest text-[#141414]/60">{title}</h2>
        </div>
        <div className="flex gap-1">
          <div className="h-1 w-1 rounded-full bg-ink/20" />
          <div className="h-1 w-1 rounded-full bg-ink/20" />
          <div className="h-1 w-1 rounded-full bg-ink/20" />
        </div>
      </div>
    )}
    {children}
  </div>
);

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'history' | 'settings'>('dashboard');
  const [isTriggering, setIsTriggering] = useState(false);
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [viewSource, setViewSource] = useState(false);
  const [nextRunInfo, setNextRunInfo] = useState<{ human: string; countdown: string } | null>(null);
  const reportRef = React.useRef<HTMLDivElement>(null);

  const formatDateTime = (timestamp: Timestamp | undefined) => {
    if (!timestamp) return 'N/A';
    return timestamp.toDate().toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  };

  const viewPDF = async (report: Report) => {
    if (!reportRef.current) return;
    
    const element = reportRef.current;
    
    const canvas = await html2canvas(element, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#E4E3E0',
      windowWidth: element.scrollWidth,
      windowHeight: element.scrollHeight,
      onclone: (clonedDoc) => {
        // html2canvas fails on modern color functions like oklab/oklch
        // We must remove them from ALL style sources
        const styleTags = clonedDoc.getElementsByTagName('style');
        for (let i = 0; i < styleTags.length; i++) {
          const style = styleTags[i];
          style.innerHTML = style.innerHTML
            .replace(/oklch\([^)]+\)/gi, '#141414')
            .replace(/oklab\([^)]+\)/gi, '#141414');
        }

        // Also check link tags (though we can't easily edit their content, we can disable them if they are likely candidates)
        const links = clonedDoc.getElementsByTagName('link');
        for (let i = 0; i < links.length; i++) {
          if (links[i].rel === 'stylesheet') {
            // If it's a local stylesheet, it might have oklch from Tailwind v4
            // We'll keep it for now but the styleTag replacement above should catch most things
          }
        }
        
        // Replace in the entire body HTML to catch inline styles
        clonedDoc.body.innerHTML = clonedDoc.body.innerHTML
          .replace(/oklch\([^)]+\)/gi, '#141414')
          .replace(/oklab\([^)]+\)/gi, '#141414');

        // Finally, iterate through all elements to catch computed styles
        const allElements = clonedDoc.getElementsByTagName('*');
        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i] as HTMLElement;
          if (el.style) {
            const props = ['color', 'backgroundColor', 'borderColor', 'fill', 'stroke', 'outlineColor'];
            props.forEach(prop => {
              try {
                const val = (el.style as any)[prop];
                if (val && (typeof val === 'string') && (val.toLowerCase().includes('oklch') || val.toLowerCase().includes('oklab'))) {
                  (el.style as any)[prop] = '#141414';
                }
              } catch (e) {}
            });
          }
        }
      }
    });
    
    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();
    
    const imgProps = pdf.getImageProperties(imgData);
    const imgWidth = pdfWidth - 20; // 10mm margins
    const imgHeight = (imgProps.height * imgWidth) / imgProps.width;
    
    let heightLeft = imgHeight;
    let position = 10; // Start with 10mm top margin

    pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
    heightLeft -= pdfHeight;

    while (heightLeft >= 0) {
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
      heightLeft -= pdfHeight;
    }

    window.open(pdf.output('bloburl'), '_blank');
  };

  // Update Next Run Info
  useEffect(() => {
    if (!settings?.interval) {
      setNextRunInfo(null);
      return;
    }

    const updateInfo = () => {
      try {
        const cp = cron as any;
        // Support both older parseExpression and newer parse method (v5+)
        const parser = cp.parse || cp.parseExpression || cp.default?.parse || cp.default?.parseExpression;
        
        let interval;
        if (typeof parser === 'function') {
          interval = parser(settings.interval);
        } else if (typeof cp === 'function' && typeof cp.parse === 'function') {
          interval = cp.parse(settings.interval);
        } else {
          logger.error('cron-parser: parse method not found', 'updateInfo', { cp, type: typeof cp });
          throw new Error('cron-parser: parse method not found');
        }

        const next = interval.next().toDate();
        
        setNextRunInfo({
          human: format(next, 'EEEE, MMM do @ HH:mm'),
          countdown: formatDistanceToNow(next, { addSuffix: true })
        });
      } catch (err) {
        logger.error('Error parsing cron', 'updateInfo', err);
        setNextRunInfo(null);
      }
    };

    updateInfo();
    const timer = setInterval(updateInfo, 60000); // Update every minute
    return () => clearInterval(timer);
  }, [settings?.interval]);

  // Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const login = () => signInWithPopup(auth, new GoogleAuthProvider());
  const logout = () => signOut(auth);

  // Data Fetching
  useEffect(() => {
    if (!user || user.email !== 'shahar.dolev@gmail.com') return;

    const unsubSettings = onSnapshot(doc(db as any, 'settings', 'global'), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as Settings;
        const trimmedInterval = data.interval?.trim();
        // Migration: If existing settings are still daily (0 9 * * *), update to weekly
        if (trimmedInterval === '0 9 * * *' || !trimmedInterval) {
          const updated = {
            ...data,
            interval: '0 9 * * 1',
            summaryPrompt: data.summaryPrompt.replace(/last 24 hours/gi, 'last week').replace(/daily/gi, 'weekly'),
            reportFormat: 'Structured weekly summary using GFM Markdown (headers, bold, bullet points, and tables using | syntax).',
            updatedAt: new Date().toISOString()
          };
          saveSettings(updated);
        } else {
          setSettings(data);
        }
      } else {
        // Initialize default settings
        const defaultSettings: Settings = {
          interval: '0 9 * * 1', // Weekly on Monday at 9 AM
          recipients: ['shahar.dolev@gmail.com'],
          summaryPrompt: 'Summarize the top 5 most impactful energy news stories from the past week, focusing on renewable energy and market trends.',
          reportFormat: 'Structured weekly summary using GFM Markdown (headers, bold, bullet points, and tables using | syntax).',
          updatedAt: new Date().toISOString()
        };
        const settingsRef = doc(db as any, 'settings', 'global');
        setDoc(settingsRef, defaultSettings).catch(err => handleFirestoreError(err, OperationType.WRITE, 'settings/global', 'initializeSettings'));
      }
    }, (err) => handleFirestoreError(err, OperationType.GET, 'settings/global', 'onSnapshotSettings'));

    const q = query(collection(db, 'reports'), orderBy('timestamp', 'desc'), limit(20));
    const unsubReports = onSnapshot(q, (snapshot) => {
      setReports(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Report)));
    }, (err) => handleFirestoreError(err, OperationType.GET, 'reports', 'onSnapshotReports'));

    return () => {
      unsubSettings();
      unsubReports();
    };
  }, [user]);

  const handleTrigger = async () => {
    setIsTriggering(true);
    try {
      await fetch('/api/trigger', { method: 'POST' });
    } catch (err) {
      logger.error('Trigger failed', 'handleTrigger', err);
    } finally {
      setIsTriggering(false);
    }
  };

  const saveSettings = async (newSettings: Settings) => {
    try {
      await setDoc(doc(db, 'settings', 'global'), { ...newSettings, updatedAt: new Date().toISOString() });
      await fetch('/api/update-schedule', { method: 'POST' });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/global', 'saveSettings');
    }
  };

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-[#E4E3E0]">
      <div className="animate-pulse font-mono text-sm uppercase tracking-widest">Initialising System...</div>
    </div>
  );

  if (!user) return (
    <div className="flex h-screen flex-col items-center justify-center bg-[#E4E3E0] p-4 text-center">
      <Zap size={48} className="mb-6 text-[#141414]" />
      <h1 className="mb-2 font-serif text-4xl italic">Energy News Reporter</h1>
      <p className="mb-8 max-w-md font-mono text-sm opacity-60">
        Automated energy sector intelligence. Please authenticate to access the command center.
      </p>
      <Button onClick={login} icon={Zap}>Authenticate with Google</Button>
    </div>
  );

  if (user.email !== 'shahar.dolev@gmail.com') return (
    <div className="flex h-screen flex-col items-center justify-center bg-[#E4E3E0] p-4 text-center">
      <XCircle size={48} className="mb-6 text-red-600" />
      <h1 className="mb-2 font-serif text-2xl italic">Access Denied</h1>
      <p className="mb-8 max-w-md font-mono text-sm opacity-60">
        Your account ({user.email}) is not authorized to access this system.
      </p>
      <Button onClick={logout} variant="outline">Sign Out</Button>
    </div>
  );

  return (
    <div className="min-h-screen bg-bg text-ink selection:bg-ink selection:text-bg">
      {/* Header */}
      <header className="border-b border-ink bg-white px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="relative">
              <Zap size={28} className="relative z-10" />
              <motion.div 
                animate={{ scale: [1, 1.2, 1], opacity: [0.2, 0.5, 0.2] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="absolute inset-0 rounded-full bg-accent blur-md"
              />
            </div>
            <div>
              <h1 className="font-serif text-2xl italic leading-none tracking-tight">Energy Intelligence</h1>
              <div className="mt-1 flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-tighter text-[#141414]/40">Command Center v1.0.5</span>
                <div className="h-1 w-1 rounded-full bg-green-500 animate-pulse" />
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-8">
            {/* System Load Visualizer */}
            <div className="hidden items-center gap-2 md:flex">
              <span className="font-mono text-[9px] uppercase text-[#141414]/40">System Load</span>
              <div className="flex gap-0.5">
                {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <div 
                    key={i} 
                    className={cn(
                      "h-3 w-1.5",
                      i < 6 ? "bg-ink/20" : "bg-ink/5"
                    )} 
                  />
                ))}
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="hidden flex-col items-end md:flex">
                <span className="font-mono text-[9px] uppercase text-[#141414]/40">Operator</span>
                <span className="font-mono text-xs font-bold">{user.email}</span>
              </div>
              <Button onClick={logout} variant="ghost" className="p-2" icon={LogOut}>
                <span className="hidden md:inline">Exit</span>
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-6xl p-6">
        {/* Navigation */}
        <nav className="mb-10 flex border-b border-ink">
          {[
            { id: 'dashboard', label: 'Overview', icon: Zap },
            { id: 'history', label: 'History', icon: History },
            { id: 'settings', label: 'Configuration', icon: SettingsIcon },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={cn(
                "group relative flex items-center gap-2 px-8 py-4 font-mono text-[10px] uppercase tracking-[0.2em] transition-all",
                activeTab === tab.id 
                  ? "bg-white font-bold" 
                  : "opacity-40 hover:opacity-100"
              )}
            >
              <tab.icon size={12} />
              {tab.label}
              {activeTab === tab.id && (
                <motion.div 
                  layoutId="nav-active"
                  className="absolute bottom-[-1px] left-0 right-0 h-1 bg-ink"
                />
              )}
            </button>
          ))}
        </nav>

        <AnimatePresence mode="wait">
          {activeTab === 'dashboard' && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="grid gap-6 md:grid-cols-3"
            >
              {/* Status Card */}
              <Card title="System Status" icon={RefreshCw} className="md:col-span-2">
                <div className="grid gap-8 md:grid-cols-2">
                  <div className="space-y-4">
                    <div className="flex flex-col">
                      <span className="font-mono text-[10px] uppercase text-[#141414]/50">Next Scheduled Run</span>
                      <div className="flex items-start gap-3">
                        <div className="mt-1 rounded-full bg-accent/20 p-2 text-accent">
                          <Clock size={18} />
                        </div>
                        <div className="flex flex-col">
                          <span className="font-mono text-lg font-bold">
                            {nextRunInfo ? nextRunInfo.human : 'Not scheduled'}
                          </span>
                          <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
                            {nextRunInfo ? `Starts ${nextRunInfo.countdown}` : 'Waiting for configuration'}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col">
                      <span className="font-mono text-[10px] uppercase text-[#141414]/50">Recipients</span>
                      <div className="flex items-center gap-2">
                        <Mail size={16} />
                        <span className="font-mono text-xs">{settings?.recipients.join(', ') || 'None'}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col justify-end gap-3 border-l border-[#141414]/10 pl-8">
                    <Button 
                      onClick={handleTrigger} 
                      disabled={isTriggering} 
                      icon={isTriggering ? RefreshCw : Play}
                      className={isTriggering ? "animate-pulse" : ""}
                    >
                      {isTriggering ? "Processing..." : "Trigger Manual Run"}
                    </Button>
                    <p className="font-mono text-[10px] italic text-[#141414]/40">
                      Manual trigger will fetch latest news and send email immediately.
                    </p>
                  </div>
                </div>
              </Card>

              {/* Latest Report Summary */}
              <Card title="Latest Intelligence" icon={FileText}>
                {reports.length > 0 ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <span className={cn(
                        "flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest",
                        reports[0].status === 'success' ? "text-green-600" : "text-red-600"
                      )}>
                        {reports[0].status === 'success' ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                        {reports[0].status}
                      </span>
                      <span className="font-mono text-[9px] uppercase text-[#141414]/40">
                        {formatDateTime(reports[0].timestamp)}
                      </span>
                    </div>
                    <h3 className="font-serif text-xl italic leading-tight terminal-glow">{reports[0].title}</h3>
                    <div className="relative overflow-hidden border border-ink/10 bg-ink/[0.02] p-4">
                      <div className="scanline" />
                      <p className="line-clamp-4 font-mono text-[11px] leading-relaxed text-[#141414]/70">
                        {reports[0].content || reports[0].error || "No content available."}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="primary" className="flex-1" onClick={() => { setSelectedReport(reports[0]); setViewSource(false); }}>
                        {reports[0].status === 'failed' ? 'View Error' : 'View Report'}
                      </Button>
                      <Button variant="outline" className="flex-1" onClick={() => setActiveTab('history')}>
                        Archive
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-32 flex-col items-center justify-center text-center text-[#141414]/20">
                    <FileText size={32} className="mb-2" />
                    <span className="font-mono text-[10px] uppercase tracking-widest">No records found</span>
                  </div>
                )}
              </Card>
            </motion.div>
          )}

          {activeTab === 'history' && (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-4"
            >
              <Card title="Report Archive" icon={History}>
                <div className="overflow-hidden">
                  <table className="w-full text-left font-mono text-[10px] uppercase tracking-wider">
                    <thead>
                      <tr className="border-b border-ink text-[#141414]/40">
                        <th className="pb-4 font-serif italic text-[9px] tracking-[0.2em]">Timestamp</th>
                        <th className="pb-4 font-serif italic text-[9px] tracking-[0.2em]">Intelligence Title</th>
                        <th className="pb-4 font-serif italic text-[9px] tracking-[0.2em]">Status</th>
                        <th className="pb-4 font-serif italic text-[9px] tracking-[0.2em] text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink/5">
                      {reports.map((report) => (
                        <tr 
                          key={report.id} 
                          onClick={() => { setSelectedReport(report); setViewSource(false); }}
                          className="group cursor-pointer transition-all hover:bg-ink hover:text-bg"
                        >
                          <td className="py-4">{formatDateTime(report.timestamp)}</td>
                          <td className="py-4 font-bold">{report.title}</td>
                          <td className="py-4">
                            <span className={cn(
                              "flex items-center gap-1",
                              report.status === 'success' ? "text-green-600 group-hover:text-green-400" : "text-red-600 group-hover:text-red-400"
                            )}>
                              {report.status === 'success' ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                              {report.status}
                            </span>
                          </td>
                          <td className="py-4 text-right">
                            <ChevronRight size={14} className="ml-auto text-[#141414]/0 transition-all group-hover:translate-x-1 group-hover:text-[#141414]/100" />
                          </td>
                        </tr>
                      ))}
                      {reports.length === 0 && (
                        <tr>
                          <td colSpan={4} className="py-12 text-center text-[#141414]/20">No intelligence logs found in database.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            </motion.div>
          )}

          {activeTab === 'settings' && (
            <motion.div
              key="settings"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
            >
              <Card title="System Configuration" icon={SettingsIcon}>
                <form 
                  onSubmit={(e) => {
                    e.preventDefault();
                    const formData = new FormData(e.currentTarget);
                    const updated: Settings = {
                      interval: formData.get('interval') as string,
                      recipients: (formData.get('recipients') as string).split(',').map(s => s.trim()),
                      summaryPrompt: formData.get('prompt') as string,
                      reportFormat: formData.get('format') as string,
                      updatedAt: new Date().toISOString()
                    };
                    saveSettings(updated);
                  }}
                  className="space-y-8"
                >
                  <div className="grid gap-8 md:grid-cols-2">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="font-serif text-[10px] italic uppercase tracking-[0.2em] text-[#141414]/60">Schedule (Cron)</label>
                        <span className="font-mono text-[8px] text-[#141414]/30">REF: ISO-8601</span>
                      </div>
                      <input 
                        name="interval"
                        defaultValue={settings?.interval}
                        className="w-full border border-ink bg-white p-4 font-mono text-xs focus:bg-ink focus:text-bg focus:outline-none transition-colors"
                        placeholder="0 9 * * *"
                      />
                      <p className="font-mono text-[9px] italic text-[#141414]/40">Standard cron format. Example: "0 9 * * *" for daily at 09:00.</p>
                    </div>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="font-serif text-[10px] italic uppercase tracking-[0.2em] text-[#141414]/60">Distribution List</label>
                        <span className="font-mono text-[8px] text-[#141414]/30">SMTP_AUTH: ENABLED</span>
                      </div>
                      <input 
                        name="recipients"
                        defaultValue={settings?.recipients.join(', ')}
                        className="w-full border border-ink bg-white p-4 font-mono text-xs focus:bg-ink focus:text-bg focus:outline-none transition-colors"
                        placeholder="operator@intel.node, analyst@intel.node"
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="font-serif text-[10px] italic uppercase tracking-[0.2em] text-[#141414]/60">Intelligence Directives</label>
                      <span className="font-mono text-[8px] text-[#141414]/30">MODEL: OPENAI/GPT-OSS-120B</span>
                    </div>
                    <textarea 
                      name="prompt"
                      defaultValue={settings?.summaryPrompt}
                      rows={6}
                      className="w-full border border-ink bg-white p-4 font-mono text-xs focus:bg-ink focus:text-bg focus:outline-none transition-colors"
                      placeholder="Define intelligence gathering parameters..."
                    />
                  </div>

                  <div className="flex items-center justify-between border-t border-ink/10 pt-8">
                    <div className="flex flex-col">
                      <span className="font-mono text-[9px] text-[#141414]/40 tracking-widest">Last Configuration Update</span>
                      <span className="font-mono text-[10px] font-bold">{settings?.updatedAt ? formatDateTime(Timestamp.fromDate(new Date(settings.updatedAt))) : 'INITIAL_BOOT'}</span>
                    </div>
                    <Button type="submit" icon={CheckCircle2}>Synchronize Settings</Button>
                  </div>
                </form>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Report Detail Modal */}
        <AnimatePresence>
          {selectedReport && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
              onClick={() => setSelectedReport(null)}
            >
              <motion.div 
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                className="max-h-[90vh] w-full max-w-3xl overflow-y-auto border border-[#141414] bg-[#E4E3E0] p-8"
                onClick={(e) => e.stopPropagation()}
              >
                <div ref={reportRef} className="p-4">
                  <div className="mb-6 flex items-center justify-between border-b border-[#141414] pb-4">
                    <div>
                      <h2 className="font-serif text-2xl italic">{selectedReport.title}</h2>
                      <p className="font-mono text-[10px] uppercase text-[#141414]/50">{formatDateTime(selectedReport.timestamp)}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <button 
                        onClick={() => setViewSource(!viewSource)}
                        className="font-mono text-[10px] uppercase tracking-widest text-[#141414]/60 hover:text-[#141414] print:hidden"
                      >
                        {viewSource ? '[ Rendered View ]' : '[ Markdown Source ]'}
                      </button>
                      <button onClick={() => setSelectedReport(null)} className="hover:opacity-50 print:hidden">
                        <XCircle size={24} />
                      </button>
                    </div>
                  </div>

                  {selectedReport.status === 'failed' ? (
                    <div className="space-y-6">
                      <div className="border border-red-600/20 bg-red-600/5 p-4">
                        <h4 className="mb-2 font-mono text-[10px] font-bold uppercase text-red-600">Error Details</h4>
                        <p className="font-mono text-sm text-red-700">{selectedReport.error}</p>
                      </div>
                      <div className="grid gap-6 md:grid-cols-2">
                        <div>
                          <h4 className="mb-2 font-serif text-xs italic uppercase tracking-widest text-[#141414]/60">Failure Stage</h4>
                          <p className="font-mono text-sm font-bold">{selectedReport.stage || 'Unknown'}</p>
                        </div>
                        <div>
                          <h4 className="mb-2 font-serif text-xs italic uppercase tracking-widest text-[#141414]/60">Last Request</h4>
                          <p className="max-h-32 overflow-y-auto font-mono text-[10px] text-[#141414]/70">{selectedReport.request || 'N/A'}</p>
                        </div>
                      </div>
                    </div>
                  ) : viewSource ? (
                    <div className="relative">
                      <div className="absolute top-2 right-2 font-mono text-[8px] uppercase text-[#141414]/30">Raw Markdown</div>
                      <pre className="whitespace-pre-wrap rounded border border-[#141414]/10 bg-[#141414]/5 p-6 font-mono text-xs leading-relaxed text-[#141414]/80">
                        {selectedReport.content}
                      </pre>
                    </div>
                  ) : (
                    <div 
                      className={cn(
                        "markdown-body max-w-none leading-relaxed",
                        isHebrew(selectedReport.content) ? "text-right text-[#141414]" : "text-left text-[#141414]"
                      )}
                      dir={isHebrew(selectedReport.content) ? "rtl" : "ltr"}
                    >
                      <ReactMarkdown 
                        remarkPlugins={[remarkGfm]}
                        components={{
                          td: ({node, ...props}) => (
                            <td {...props} className={cn(props.className, isHebrew(selectedReport.content) && "text-right")} />
                          ),
                          th: ({node, ...props}) => (
                            <th {...props} className={cn(props.className, isHebrew(selectedReport.content) && "text-right")} />
                          )
                        }}
                      >
                        {selectedReport.content}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>

                <div className="mt-8 flex justify-end gap-3 border-t border-[#141414]/10 pt-6">
                  <Button variant="outline" onClick={() => viewPDF(selectedReport)}>View PDF</Button>
                  <Button onClick={() => setSelectedReport(null)}>Close Report</Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="mt-12 border-t border-[#141414] bg-white px-6 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 md:flex-row">
          <div className="flex items-center gap-2 text-[#141414]/40">
            <Zap size={14} />
            <span className="font-mono text-[10px] uppercase tracking-widest">Energy Intel Node 01</span>
          </div>
          <div className="font-mono text-[10px] text-[#141414]/40">
            &copy; 2026 Energy Intelligence Systems. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}
