import React, { useMemo, useState, useCallback } from 'react'
import { Provider, defaultTheme, Flex, View, Heading, Text, StatusLight, ActionButton, DialogTrigger, Dialog, Content, Button, ButtonGroup, Tabs, TabList, Item } from '@adobe/react-spectrum'
import HelpIcon from '@spectrum-icons/workflow/Help'
import endpoints from './config.json'
import { createApi } from './utils'
import Operate from './components/Operate'
import Configure from './components/Configure'
import Settings from './components/Settings'
import Consoles from './components/Consoles'
import Help from './components/Help'

function resolveUiApiUrl () {
  const fromConfig = endpoints && (endpoints['aem-content-sync/ui-api'] || endpoints['ui-api'])
  const url = fromConfig || `${window.location.origin}/api/v1/web/aem-content-sync/ui-api`
  // Always call the Runtime host directly. The static-CDN host proxies actions
  // but can return CloudFront 503s (esp. right after a web deploy) and adds a
  // hop; the runtime host returns proper CORS (`*`) for cross-origin calls (and
  // for the deployed app served from adobeio-static.net this is a clean
  // same-org cross-origin call).
  return url.replace('adobeio-static.net', 'adobeioruntime.net')
}

export default function App ({ ims }) {
  const api = useMemo(() => createApi(resolveUiApiUrl(), ims && ims.token, ims && ims.org), [ims])
  const [online, setOnline] = useState(null)
  const [tab, setTab] = useState('operate')
  const onHealth = useCallback((ok) => setOnline(ok), [])
  return (
    <Provider theme={defaultTheme} colorScheme="light" UNSAFE_style={{ minHeight: '100vh' }}>
      <Flex direction="column" minHeight="100vh">
        <View paddingX="size-600" paddingTop="size-400" paddingBottom="size-200" backgroundColor="gray-75" borderBottomWidth="thin" borderBottomColor="gray-300">
          <Flex direction="row" justifyContent="space-between" alignItems="center">
            <Flex direction="column" gap="size-50">
              <Heading level={1} margin={0} UNSAFE_style={{ fontSize: '24px' }}>Content Sync</Heading>
              <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-gray-700)' }}>Scheduled content copy &amp; publish between AEM author environments</Text>
            </Flex>
            <Flex direction="column" gap="size-100" alignItems="end">
              <Flex direction="row" gap="size-200" alignItems="center">
                <StatusLight variant={online === null ? 'neutral' : online ? 'positive' : 'negative'}>{online === null ? 'Connecting…' : online ? 'Connected' : 'Backend unreachable'}</StatusLight>
                <DialogTrigger type="fullscreen">
                  <ActionButton aria-label="Help"><HelpIcon /></ActionButton>
                  {(close) => (
                    <Dialog>
                      <Heading>Help &amp; status</Heading>
                      <Content><Help api={api} /></Content>
                      <ButtonGroup><Button variant="secondary" onPress={close}>Close</Button></ButtonGroup>
                    </Dialog>
                  )}
                </DialogTrigger>
              </Flex>
              <Consoles api={api} />
            </Flex>
          </Flex>
          <Tabs aria-label="Sections" selectedKey={tab} onSelectionChange={setTab} marginTop="size-200">
            <TabList><Item key="operate">Operate</Item><Item key="configure">Configure</Item><Item key="settings">Settings</Item></TabList>
          </Tabs>
        </View>
        <View flex paddingX="size-600" paddingY="size-400">
          <div style={{ display: tab === 'operate' ? 'block' : 'none' }}><Operate api={api} onHealth={onHealth} /></div>
          <div style={{ display: tab === 'configure' ? 'block' : 'none' }}><Configure api={api} onHealth={onHealth} /></div>
          <div style={{ display: tab === 'settings' ? 'block' : 'none' }}><Settings api={api} onHealth={onHealth} active={tab === 'settings'} /></div>
        </View>
      </Flex>
    </Provider>
  )
}
