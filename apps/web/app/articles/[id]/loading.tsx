export default function ArticleLoading() {
  return (
    <div style={{ maxWidth: '680px', margin: '80px auto', padding: '0 24px' }}>
      {[60, 100, 85, 90, 75].map((width, index) => (
        <div
          key={width}
          className="skeleton"
          style={{
            height: index === 0 ? '32px' : '15px',
            width: `${width}%`,
            marginBottom: index === 0 ? '32px' : '10px',
            borderRadius: '4px',
          }}
        />
      ))}
    </div>
  )
}
