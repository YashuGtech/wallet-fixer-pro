/* eslint-disable @typescript-eslint/no-explicit-any */
// Runtime config for the FAP Rewards mini app. Values come from env vars at
// call time (never at module scope) so the serverless runtime can inject them.

export type CommunityLink = { label: string; url: string };

const env = (k: string, d = '') => (process.env[k] ?? d) as string;

export function getConfig() {
  return {
    botToken: env('BOT_TOKEN'),
    webappUrl: env('WEBAPP_URL'),
    apiUrl: env('API_URL'),
    backendUrl: env('FAP_BACKEND_URL') || env('API_URL'),
    databaseUrl: env('DATABASE_URL'),
    botUsername: env('BOT_USERNAME', 'FAPRewards_OfficialBot'),
    appShortName: env('MINI_APP_SHORT_NAME', 'app'),
    adminId: env('ADMIN_ID', '5574348933'),
    adminKey: env('ADMIN_KEY', 'changeme'),
    adsgramBlockId: env('ADSGRAM_BLOCK_ID'),
    monetagZone: env('MONETAG_ZONE'),
    minAmount: Number(env('MIN_AMOUNT', '9')),
    maxAmount: Number(env('MAX_AMOUNT', '98.7')),
    withdrawFee: Number(env('WITHDRAW_FEE', '20')),
    minWithdraw: Number(env('MIN_WITHDRAW', '50')),
    channels: env('CHANNELS', '@NitroxBots,@ARSGiftCode,@PowerxHub,@FAPgvPAYOUTS,@Crpto_Hnter')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    communityLinks: [
      { label: '▶️ YouTube', url: 'https://youtube.com/@yashu_web3?si=OFbq2cXJs5XhhIEF' },
      { label: '💬 WhatsApp', url: 'https://whatsapp.com/channel/0029Vb8qLyYCXC3CgdTJMP2k' },
      { label: '📷 Instagram', url: 'https://www.instagram.com/not_here.see?igsh=MXRhY3MxZ3dtOTU0bw==' },
    ] as CommunityLink[],
  };
}

export type FapConfig = ReturnType<typeof getConfig>;
