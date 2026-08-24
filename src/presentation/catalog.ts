import type { BackgroundError } from "../domain/types";

export const presentationCopy = {
  brand: "FOCUS LOCK",
  title: "Pomodoro",
  idle: {
    sectionLabel: "Sessão pronta",
    status: "Pronto para focar",
    profileLabel: "Perfil",
    durationLabel: "Duração",
    duration: (minutes: number) => `${minutes} min`,
    sitesNote: (count: number) => formatSiteCount(count),
    durationOption: (minutes: number) => `${minutes} minutos`,
    endTime: (time: string) => `Termina às ${time}`,
    blockCurrentSite: "Bloquear este site",
    reviewAndStart: "Revisar e começar",
    manageProfiles: "Cuidar dos perfis"
  },
  confirmation: {
    sectionLabel: "Revisão da sessão",
    kicker: "Revisão da sessão",
    summary: (minutes: number) => `${minutes} minutos`,
    endTime: (time: string) => `Termina às ${time}`,
    hold: "Mantenha pressionado por 2 segundos",
    starting: "Iniciando…",
    back: "Voltar",
    notice: "Durante a sessão, estes sites ficarão inacessíveis. Depois de 60 segundos, não será possível cancelar."
  },
  active: {
    sectionLabel: "Sessão ativa",
    status: "Estado da sessão",
    profileLabel: "Perfil em foco",
    readOnly: "As regras ficam somente para leitura durante a sessão.",
    cancelable: "Você ainda pode cancelar",
    protected: "Sessão protegida",
    protectedNote: "O compromisso não pode mais ser cancelado.",
    cancel: (seconds: number) => `Cancelar sessão · ${seconds}s`,
    endTime: (time: string) => `Termina às ${time}`
  },
  announcements: {
    review: "Revisão da sessão",
    started: "Sessão iniciada. Você ainda pode cancelar",
    protected: "Sessão protegida",
    cancelled: "Sessão cancelada"
  },
  errors: {
    INVALID_HOSTNAME: "Informe um hostname ou URL HTTP(S) válido.",
    PROTECTED_HOSTNAME: "Esse host é protegido pelo Firefox.",
    HOST_ALREADY_COVERED: "Essa regra já está coberta por outra.",
    PROFILE_EMPTY: "Adicione pelo menos uma regra antes de iniciar.",
    PROFILE_REQUIRED: "Selecione um perfil para iniciar.",
    PROFILE_NOT_FOUND: "O perfil selecionado não está mais disponível.",
    INVALID_DURATION: "Escolha uma duração entre 5 e 180 minutos, em passos de 5.",
    PRIVATE_PERMISSION_REQUIRED: "Permita o uso em janelas privadas nas configurações do Firefox.",
    SESSION_ALREADY_ACTIVE: "Já existe uma sessão em andamento.",
    URL_UNAVAILABLE: "A aba atual não tem uma URL HTTP(S) disponível.",
    NO_ACTIVE_SESSION: "Não há uma sessão ativa para cancelar.",
    CANCEL_WINDOW_CLOSED: "A janela de cancelamento terminou.",
    STORAGE_ERROR: "Não foi possível carregar o Focus Lock.",
    INVALID_PROFILE_NAME: "Use um nome de perfil entre 1 e 40 caracteres.",
    DUPLICATE_PROFILE_NAME: "Já existe um perfil com esse nome.",
    LAST_PROFILE: "Mantenha pelo menos um perfil.",
    PROFILE_IN_SESSION: "O perfil da sessão atual está protegido.",
    CONFIRM_CONSOLIDATION: "Confirme a consolidação das regras.",
    HOSTNAME_REQUIRED: "Informe um hostname ou URL HTTP(S).",
    IMPORT_SESSION_ACTIVE: "Encerre a sessão atual antes de importar uma configuração.",
    BACKUP_TOO_LARGE: "O backup excede o limite permitido.",
    INVALID_BACKUP: "O arquivo não é um backup Focus Lock válido.",
    UNSUPPORTED_BACKUP_VERSION: "A versão deste backup não é compatível.",
    CONFIGURATION_CHANGED: "A configuração mudou. Tente novamente."
  } satisfies Partial<Record<BackgroundError, string>>,
  recoveries: {
    loadLabel: "Erro ao carregar",
    recoverProfiles: "Cuidar dos perfis",
    refreshState: "Atualizar estado",
    retry: "Tentar novamente"
  },
  prompts: {
    consolidation: (hosts: string) => `Esta regra absorve ${hosts}. Continuar?`
  },
  loading: "Carregando…"
} as const;

export function formatSiteCount(count: number): string {
  return `${count} ${count === 1 ? "site" : "sites"}`;
}

export function formatEndTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatRemaining(endsAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function popupErrorMessage(error: string): string {
  return presentationCopy.errors[error as BackgroundError] ?? presentationCopy.errors.STORAGE_ERROR;
}
