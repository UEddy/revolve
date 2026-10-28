import { VaultProvider, useVault } from "./state/vault.tsx";
import { EngineProvider } from "./state/engine.tsx";
import { CreditsProvider } from "./state/credits.tsx";
import { FundScreen, FundingScreen } from "./screens/Fund.tsx";
import { MarketScreen, NftScreen } from "./screens/Collectibles.tsx";
import { useRoute, href } from "./router.ts";
import { Welcome, Unlock } from "./screens/Gate.tsx";
import { Home } from "./screens/Home.tsx";
import { Discover } from "./screens/Discover.tsx";
import { TokenScreen } from "./screens/Token.tsx";
import { BaseScreen, BaseTokenScreen } from "./screens/Base.tsx";
import { HistoryScreen } from "./screens/History.tsx";
import { PositionScreen } from "./screens/Position.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Compass, Gear, Wallet } from "./components/icons.tsx";
import { MOCK, ORDER_API } from "./lib/config.ts";
import { InstallBanner } from "./components/InstallBanner.tsx";

function Tabs({ at }: { at: string }) {
  const tab = (to: string, name: string, label: string, Icon: typeof Wallet) => (
    <a href={to} aria-current={at === name ? "page" : undefined}>
      <Icon /> {at === name && label}
    </a>
  );
  return (
    <nav className="tabs">
      {tab(href.home, "home", "Portfolio", Wallet)}
      {tab(href.discover, "discover", "Discover", Compass)}
      {tab(href.settings, "settings", "Settings", Gear)}
    </nav>
  );
}

function Screens() {
  const route = useRoute();
  const { phase } = useVault();
  if (phase === "loading") return null;
  if (phase === "none") return <Welcome />;
  if (phase === "locked") return <Unlock />;
  return (
    <EngineProvider>
      <CreditsProvider>
      {route.name === "home" && <Home />}
      {route.name === "discover" && <Discover />}
      {route.name === "token" && <TokenScreen key={route.mint} mint={route.mint} />}
      {route.name === "position" && <PositionScreen key={route.id} id={route.id} />}
      {route.name === "settings" && <Settings />}
      {route.name === "fund" && <FundScreen />}
      {route.name === "funding" && <FundingScreen key={route.id} id={route.id} />}
      {route.name === "market" && <MarketScreen key={route.id} id={route.id} />}
      {route.name === "nft" && <NftScreen key={route.symbol} symbol={route.symbol} />}
      {route.name === "base" && <BaseScreen />}
      {route.name === "history" && <HistoryScreen />}
      {route.name === "baseToken" && <BaseTokenScreen key={route.address} address={route.address} />}
      {(route.name === "home" || route.name === "discover" || route.name === "settings") && (
        <>
          <Tabs at={route.name} />
          {/* Only on the tab screens: never over a payment, funding or buy flow. */}
          <InstallBanner />
        </>
      )}
      </CreditsProvider>
    </EngineProvider>
  );
}

export function App() {
  return (
    <VaultProvider>
      {MOCK && <div className="banner">Demo mode: orders pay themselves, no money moves</div>}
      {ORDER_API === null && <div className="banner">Order service not configured</div>}
      <Screens />
    </VaultProvider>
  );
}
