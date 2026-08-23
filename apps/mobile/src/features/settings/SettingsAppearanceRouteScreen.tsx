import { useNavigation } from "@react-navigation/native";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { TerminalAppearanceSection } from "./appearance/sections/TerminalAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";
import { ThemeAppearanceSection } from "./appearance/sections/ThemeAppearanceSection";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useAppearancePreferences } from "./appearance/AppearancePreferencesProvider";

export function SettingsAppearanceRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { expandToolCallsByDefault, isReady, setExpandToolCallsByDefault } =
    useAppearancePreferences();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Appearance" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <ThemeAppearanceSection />
        <TextAppearanceSection />
        <TerminalAppearanceSection />
        <CodeAppearanceSection />
        <SettingsSection card title="Chat">
          <SettingsSwitchRow
            disabled={!isReady}
            icon="chevron.down"
            label="Expand tool calls"
            subtitle="Show every tool call in completed turns by default."
            onValueChange={setExpandToolCallsByDefault}
            value={expandToolCallsByDefault}
          />
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
