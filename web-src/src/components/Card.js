import React from 'react'
import { View, Heading } from '@adobe/react-spectrum'

/* A simple elevated card container for grouping content. */
export default function Card ({ title, children, ...rest }) {
  return (
    <View
      backgroundColor="gray-50"
      borderWidth="thin"
      borderColor="gray-200"
      borderRadius="medium"
      padding="size-350"
      UNSAFE_style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}
      {...rest}>
      {title && <Heading level={4} marginTop={0} marginBottom="size-200">{title}</Heading>}
      {children}
    </View>
  )
}
